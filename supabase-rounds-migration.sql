-- ============================================================
-- منصة مراقبة الدوام - مدينة الملك سلمان الطبية
-- ترحيل: الجولة متعددة الأقسام مع اعتماد المدير المناوب للجولة كاملة
-- ------------------------------------------------------------
-- يُنفَّذ بعد supabase-schema.sql و supabase-approvals-migration.sql
--   Supabase > SQL Editor ← الصق الملف كاملاً ← Run
--   (آمن للإعادة — كل الأوامر idempotent، لا يمس البيانات الحالية)
--
-- الفكرة:
--   - جدول rounds: رأس الجولة (تاريخ/يوم/فترة/مستشفى) + بيانات
--     اعتماد واحدة على مستوى الجولة (وليس لكل قسم)
--   - جدول round_sections: أقسام الجولة، كل قسم مرتبط بـ round_id
--   - دالة submit_approved_round: لا حفظ نهائياً إلا بعد التحقق من
--     كود المدير المناوب وتوقيعه — تُحفظ الجولة كاملة معتمدة ذرّياً
--   - لعدم كسر التقارير والإحصائيات الحالية: تُدرج نسخة من كل قسم
--     في جدول reports بحالة approved (فلا تظهر إلا الجولات المعتمدة)
-- ============================================================

-- ============================================================
-- 1) جدول الجولات الرئيسي
-- ============================================================
create table if not exists rounds (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  date date not null,
  day text,
  period text not null,
  hospital text not null,
  entered_by text,
  employee_code text,
  -- بيانات الاعتماد — مرة واحدة على مستوى الجولة كاملة
  approval_status text not null default 'approved'
    check (approval_status in ('pending','approved','rejected')),
  approved_by text,
  approved_at timestamptz,
  approval_signature text,
  approval_code_used text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2) جدول أقسام الجولة — كل قسم تابع لجولة عبر round_id
-- ============================================================
create table if not exists round_sections (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  department text not null,
  total integer default 0,
  present integer default 0,
  absent integer default 0,
  withdrawn integer default 0,
  leave_count integer default 0,
  absent_names text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_rounds_date            on rounds(date);
create index if not exists idx_rounds_status          on rounds(approval_status);
create index if not exists idx_round_sections_round   on round_sections(round_id);

-- ربط صفوف reports المرآتية بجولتها الأم (للتتبع)
alter table reports add column if not exists round_client_id text;
create index if not exists idx_reports_round on reports(round_client_id);

-- ============================================================
-- 3) RLS — لا وصول للمجهول إلا عبر الدالة أدناه
-- ============================================================
alter table rounds         enable row level security;
alter table round_sections enable row level security;

do $$ begin
  create policy "admin select rounds" on rounds
    for select to authenticated using (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin update rounds" on rounds
    for update to authenticated using (is_admin()) with check (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin delete rounds" on rounds
    for delete to authenticated using (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin select round_sections" on round_sections
    for select to authenticated using (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin update round_sections" on round_sections
    for update to authenticated using (is_admin()) with check (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin delete round_sections" on round_sections
    for delete to authenticated using (is_admin());
exception when duplicate_object then null; end $$;

-- ============================================================
-- 4) دالة الحفظ النهائي: اعتماد الجولة كاملة (security definer)
--    p البنية المتوقعة:
--    {
--      "client_id": "...", "date": "YYYY-MM-DD", "day": "...",
--      "period": "...", "hospital": "...", "signature": "data:image/png;...",
--      "sections": [
--        { "department": "...", "total": 0, "present": 0, "absent": 0,
--          "withdrawn": 0, "leave": 0, "absentNames": "...", "notes": "..." },
--        ...
--      ]
--    }
--    النتائج: ok | invalid_employee_code | invalid_manager_code |
--             signature_required | no_sections | duplicate_round |
--             duplicate_section:<القسم> | bad_payload
-- ============================================================
create or replace function submit_approved_round(p_emp_code text, p_mgr_code text, p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_emp_name text;
  v_mgr_name text;
  v_round_id uuid;
  v_round_client_id text;
  v_sec jsonb;
  v_idx int := 0;
begin
  -- (1) التحقق من كود مدخل البيانات
  select name into v_emp_name from employees where upper(code) = upper(trim(p_emp_code));
  if v_emp_name is null then return 'invalid_employee_code'; end if;

  -- (2) التحقق من كود المدير المناوب — لا اعتماد ولا حفظ بدونه
  select name into v_mgr_name from duty_managers where upper(code) = upper(trim(p_mgr_code));
  if v_mgr_name is null then return 'invalid_manager_code'; end if;

  -- (3) التوقيع الإلكتروني إلزامي
  if coalesce(p->>'signature', '') = '' then return 'signature_required'; end if;

  -- (4) قسم واحد على الأقل
  if jsonb_typeof(p->'sections') <> 'array' or jsonb_array_length(p->'sections') = 0 then
    return 'no_sections';
  end if;
  if coalesce(p->>'date','') = '' or coalesce(p->>'period','') = '' or coalesce(p->>'hospital','') = '' then
    return 'bad_payload';
  end if;

  -- (5) منع تكرار جولة معتمدة لنفس (التاريخ/المستشفى/الفترة)
  if exists (
    select 1 from rounds
    where date = (p->>'date')::date
      and hospital = p->>'hospital'
      and period   = p->>'period'
      and approval_status = 'approved'
  ) then
    return 'duplicate_round';
  end if;

  -- (6) منع تكرار قسم له تقرير سابق غير مرفوض لنفس (التاريخ/المستشفى/القسم/الفترة)
  for v_sec in select * from jsonb_array_elements(p->'sections') loop
    if coalesce(v_sec->>'department','') = '' then return 'bad_payload'; end if;
    if exists (
      select 1 from reports
      where date = (p->>'date')::date
        and hospital   = p->>'hospital'
        and department = v_sec->>'department'
        and period     = p->>'period'
        and status <> 'rejected'
    ) then
      return 'duplicate_section:' || (v_sec->>'department');
    end if;
  end loop;

  -- (7) إدراج رأس الجولة معتمداً — بيانات الاعتماد مرة واحدة على مستوى الجولة
  v_round_client_id := coalesce(nullif(p->>'client_id',''), gen_random_uuid()::text);
  insert into rounds (client_id, date, day, period, hospital, entered_by, employee_code,
                      approval_status, approved_by, approved_at, approval_signature, approval_code_used)
  values (v_round_client_id, (p->>'date')::date, p->>'day', p->>'period', p->>'hospital',
          v_emp_name, upper(trim(p_emp_code)),
          'approved', v_mgr_name, now(), p->>'signature', upper(trim(p_mgr_code)))
  returning id into v_round_id;

  -- (8) إدراج الأقسام + نسخة مرآتية معتمدة في reports (لتستمر كل التقارير والإحصائيات بلا كسر)
  for v_sec in select * from jsonb_array_elements(p->'sections') loop
    v_idx := v_idx + 1;

    insert into round_sections (round_id, department, total, present, absent, withdrawn, leave_count, absent_names, notes)
    values (v_round_id, v_sec->>'department',
            coalesce((v_sec->>'total')::int, 0), coalesce((v_sec->>'present')::int, 0),
            coalesce((v_sec->>'absent')::int, 0), coalesce((v_sec->>'withdrawn')::int, 0),
            coalesce((v_sec->>'leave')::int, 0),
            v_sec->>'absentNames', v_sec->>'notes');

    insert into reports (client_id, round_client_id, date, day, period, hospital, department,
                         total, present, absent, withdrawn, leave_count, absent_names, notes,
                         entered_by, employee_code, status,
                         approved_by, approver_title, approved_at, approval_signature)
    values (v_round_client_id || '-s' || v_idx, v_round_client_id,
            (p->>'date')::date, p->>'day', p->>'period', p->>'hospital', v_sec->>'department',
            coalesce((v_sec->>'total')::int, 0), coalesce((v_sec->>'present')::int, 0),
            coalesce((v_sec->>'absent')::int, 0), coalesce((v_sec->>'withdrawn')::int, 0),
            coalesce((v_sec->>'leave')::int, 0),
            v_sec->>'absentNames', v_sec->>'notes',
            v_emp_name, upper(trim(p_emp_code)), 'approved',
            v_mgr_name, 'المدير المناوب', now(), p->>'signature')
    on conflict (client_id) do nothing;
  end loop;

  -- (9) تدقيق
  insert into audit_log (action, details, actor)
  values ('اعتماد جولة كاملة',
          (p->>'date') || ' — ' || (p->>'hospital') || ' (' || (p->>'period') || ') — '
          || v_idx || ' قسم — اعتماد: ' || v_mgr_name,
          v_emp_name);
  return 'ok';
end $$;

-- ============================================================
-- 5) قراءة جولات الموظف (لعرض جولاته السابقة إن لزم)
-- ============================================================
create or replace function get_my_rounds(p_code text)
returns table(
  client_id text, date date, day text, period text, hospital text,
  approval_status text, approved_by text, approved_at timestamptz,
  sections_count bigint, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from employees where upper(code) = upper(trim(p_code))) then
    return;
  end if;
  return query
    select r.client_id, r.date, r.day, r.period, r.hospital,
           r.approval_status, r.approved_by, r.approved_at,
           count(s.id) as sections_count, r.created_at
    from rounds r
    left join round_sections s on s.round_id = r.id
    where upper(r.employee_code) = upper(trim(p_code))
    group by r.id
    order by r.created_at desc;
end $$;

-- ============================================================
-- 6) قائمة أسماء المدراء المناوبين (للقائمة المنسدلة في صفحة الموظف)
--    أسماء فقط — لا تكشف الأكواد
-- ============================================================
create or replace function list_duty_managers()
returns table(name text)
language sql stable security definer set search_path = public as $$
  select name from duty_managers order by name;
$$;

-- ============================================================
-- 7) صلاحيات التنفيذ
-- ============================================================
revoke execute on function submit_approved_round(text, text, jsonb) from public;
revoke execute on function get_my_rounds(text)                      from public;
revoke execute on function list_duty_managers()                     from public;
grant  execute on function submit_approved_round(text, text, jsonb) to anon, authenticated;
grant  execute on function get_my_rounds(text)                      to anon, authenticated;
grant  execute on function list_duty_managers()                     to anon, authenticated;
