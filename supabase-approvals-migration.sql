-- ============================================================
-- منصة مراقبة الدوام - مدينة الملك سلمان الطبية
-- ترحيل: نظام اعتماد الجولات (مدير المناوبة)
-- ------------------------------------------------------------
-- طريقة الاستخدام:
--   Supabase > SQL Editor ← الصق الملف كاملاً ← Run
--   (آمن للإعادة — كل الأوامر idempotent، لا يمس البيانات الحالية)
--
-- ملاحظة أمنية حول سياسات RLS المطلوبة:
--   - الموظف ومدير المناوبة يدخلان بكود (بدون Supabase Auth)،
--     لذا تُفرض صلاحياتهما عبر دوال RPC بنمط security definer
--     تتحقق من الكود داخلياً قبل أي قراءة/كتابة — وهذا يعادل
--     سياسات RLS لكن للمستخدم المجهول:
--       * الموظف: يرى ويعدّل جولاته فقط قبل اعتمادها (get_my_reports / update_my_report)
--       * مدير المناوبة: يعتمد/يرفض/يعيد جميع الجولات (manager_* أدناه)
--   - المدير العام (Admin عبر Supabase Auth): سياسات RLS الحالية
--     "admin update reports" تمنحه رؤية وتعديل واعتماد وإلغاء
--     اعتماد جميع الجولات.
-- ============================================================

-- ============================================================
-- 1) حقول الاعتماد الجديدة على جدول reports
--    (approved_by و approved_at موجودان في المخطط v2 — تُضاف احتياطاً)
-- ============================================================
alter table reports add column if not exists approval_status    text not null default 'pending';
alter table reports add column if not exists approved_by        text;
alter table reports add column if not exists approved_at        timestamptz;
alter table reports add column if not exists approval_signature text;
alter table reports add column if not exists rejected_reason    text;
alter table reports add column if not exists returned_for_edit  boolean not null default false;
alter table reports add column if not exists approved_date      date;
alter table reports add column if not exists approved_time      time;
alter table reports add column if not exists return_note        text;

-- القيم المسموح بها: pending / approved / rejected
do $$ begin
  alter table reports add constraint reports_approval_status_check
    check (approval_status in ('pending','approved','rejected'));
exception when duplicate_object then null; end $$;

-- ============================================================
-- 2) مزامنة تلقائية بين الحقول القديمة والجديدة
--    status ← مصدر الحقيقة (يستخدمه الكود الحالي دون كسر)
--    approval_status / rejected_reason / approved_date / approved_time
--    تُشتق تلقائياً في كل إدراج أو تحديث
-- ============================================================
create or replace function sync_report_approval_fields()
returns trigger language plpgsql as $$
begin
  new.approval_status := coalesce(new.status, 'pending');
  new.rejected_reason := new.rejection_reason;
  if new.approved_at is not null then
    new.approved_date := (new.approved_at at time zone 'Asia/Riyadh')::date;
    new.approved_time := (new.approved_at at time zone 'Asia/Riyadh')::time(0);
  else
    new.approved_date := null;
    new.approved_time := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_report_approval on reports;
create trigger trg_sync_report_approval
  before insert or update on reports
  for each row execute function sync_report_approval_fields();

-- ملء الحقول الجديدة للسجلات الموجودة مسبقاً (يمر عبر الـ trigger)
update reports set status = status;

create index if not exists idx_reports_approval_status on reports(approval_status);

-- ============================================================
-- 3) جدول مدراء المناوبة (الدخول بكود خاص مثل الموظفين)
--    الإدارة من لوحة المسؤول (سياسات admin فقط — لا وصول للمجهول)
-- ============================================================
create table if not exists duty_managers (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  name text not null,
  code text not null unique,
  created_at timestamptz not null default now()
);

alter table duty_managers enable row level security;

do $$ begin
  create policy "admin select duty_managers" on duty_managers
    for select to authenticated using (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin insert duty_managers" on duty_managers
    for insert to authenticated with check (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin update duty_managers" on duty_managers
    for update to authenticated using (is_admin()) with check (is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "admin delete duty_managers" on duty_managers
    for delete to authenticated using (is_admin());
exception when duplicate_object then null; end $$;

-- ============================================================
-- 4) دوال مدير المناوبة (security definer — تحقق داخلي من الكود)
-- ============================================================

-- تحقق كود مدير المناوبة: يعيد الاسم فقط
create or replace function verify_manager_code(p_code text)
returns table(name text)
language sql stable security definer set search_path = public as $$
  select name from duty_managers
  where upper(code) = upper(trim(p_code))
  limit 1;
$$;

-- قائمة جميع الجولات لمدير المناوبة
create or replace function manager_list_reports(p_code text)
returns setof reports
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from duty_managers where upper(code) = upper(trim(p_code))) then
    return;
  end if;
  return query select * from reports order by created_at desc;
end $$;

-- اعتماد جولة: يسجل الاسم والتاريخ والوقت والتوقيع، ولا يقبل إلا جولة بانتظار الاعتماد
create or replace function manager_approve_report(p_code text, p_client_id text, p_signature text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_rec reports%rowtype;
begin
  select name into v_name from duty_managers where upper(code) = upper(trim(p_code));
  if v_name is null then return 'invalid_code'; end if;
  if p_signature is null or p_signature = '' then return 'signature_required'; end if;

  select * into v_rec from reports where client_id = p_client_id;
  if v_rec.id is null then return 'not_found'; end if;
  if v_rec.status = 'approved' then return 'already_approved'; end if;

  update reports set
    status = 'approved',
    approved_by = v_name,
    approver_title = 'مدير المناوبة',
    approved_at = now(),
    approval_signature = p_signature,
    rejection_reason = null,
    rejected_at = null,
    returned_for_edit = false,
    return_note = null,
    updated_at = now()
  where client_id = p_client_id;

  insert into audit_log (action, details, actor)
  values ('اعتماد جولة', v_rec.date || ' — ' || coalesce(v_rec.hospital,'') || ' / ' || coalesce(v_rec.department,'') || ' (' || coalesce(v_rec.period,'') || ')', v_name);
  return 'ok';
end $$;

-- رفض جولة: سبب الرفض إلزامي، وتعود للموظف للتعديل
create or replace function manager_reject_report(p_code text, p_client_id text, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_rec reports%rowtype;
begin
  select name into v_name from duty_managers where upper(code) = upper(trim(p_code));
  if v_name is null then return 'invalid_code'; end if;
  if p_reason is null or trim(p_reason) = '' then return 'reason_required'; end if;

  select * into v_rec from reports where client_id = p_client_id;
  if v_rec.id is null then return 'not_found'; end if;
  if v_rec.status = 'approved' then return 'already_approved'; end if;

  update reports set
    status = 'rejected',
    rejection_reason = trim(p_reason),
    rejected_at = now(),
    returned_for_edit = true,
    approved_by = null,
    approved_at = null,
    approval_signature = null,
    updated_at = now()
  where client_id = p_client_id;

  insert into audit_log (action, details, actor)
  values ('رفض جولة', v_rec.date || ' — ' || coalesce(v_rec.hospital,'') || ' / ' || coalesce(v_rec.department,'') || ' — السبب: ' || trim(p_reason), v_name);
  return 'ok';
end $$;

-- إرجاع الجولة للموظف لإعادة التعديل (تبقى بانتظار الاعتماد مع علامة الإعادة)
create or replace function manager_return_report(p_code text, p_client_id text, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_rec reports%rowtype;
begin
  select name into v_name from duty_managers where upper(code) = upper(trim(p_code));
  if v_name is null then return 'invalid_code'; end if;

  select * into v_rec from reports where client_id = p_client_id;
  if v_rec.id is null then return 'not_found'; end if;
  if v_rec.status = 'approved' then return 'already_approved'; end if;

  update reports set
    returned_for_edit = true,
    return_note = nullif(trim(coalesce(p_note,'')), ''),
    updated_at = now()
  where client_id = p_client_id;

  insert into audit_log (action, details, actor)
  values ('إرجاع جولة للموظف', v_rec.date || ' — ' || coalesce(v_rec.hospital,'') || ' / ' || coalesce(v_rec.department,''), v_name);
  return 'ok';
end $$;

-- ============================================================
-- 5) دوال الموظف: رؤية وتعديل جولاته فقط قبل اعتمادها
-- ============================================================

-- جولات الموظف (بكوده فقط)
create or replace function get_my_reports(p_code text)
returns setof reports
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from employees where upper(code) = upper(trim(p_code))) then
    return;
  end if;
  return query
    select * from reports
    where upper(employee_code) = upper(trim(p_code))
    order by created_at desc;
end $$;

-- تعديل جولة مرفوضة/مُعادة: تعود تلقائياً إلى "بانتظار الاعتماد"
create or replace function update_my_report(p_code text, p_client_id text, p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_rec reports%rowtype;
begin
  select name into v_name from employees where upper(code) = upper(trim(p_code));
  if v_name is null then return 'invalid_code'; end if;

  select * into v_rec from reports where client_id = p_client_id;
  if v_rec.id is null then return 'not_found'; end if;
  if upper(coalesce(v_rec.employee_code,'')) <> upper(trim(p_code)) then return 'not_owner'; end if;
  if v_rec.status = 'approved' then return 'already_approved'; end if;

  -- منع التكرار مع جولة أخرى بنفس (التاريخ/المستشفى/القسم/الفترة)
  if exists (
    select 1 from reports
    where date = (p->>'date')::date
      and hospital   = p->>'hospital'
      and department = p->>'department'
      and period     = p->>'period'
      and status <> 'rejected'
      and client_id <> p_client_id
  ) then
    return 'duplicate';
  end if;

  update reports set
    date        = (p->>'date')::date,
    day         = p->>'day',
    period      = p->>'period',
    hospital    = p->>'hospital',
    department  = p->>'department',
    total       = coalesce((p->>'total')::int, 0),
    present     = coalesce((p->>'present')::int, 0),
    absent      = coalesce((p->>'absent')::int, 0),
    withdrawn   = coalesce((p->>'withdrawn')::int, 0),
    leave_count = coalesce((p->>'leave')::int, 0),
    absent_names = p->>'absentNames',
    notes       = p->>'notes',
    status      = 'pending',
    rejection_reason = null,
    rejected_at = null,
    returned_for_edit = false,
    return_note = null,
    approved_by = null,
    approved_at = null,
    approval_signature = null,
    updated_at  = now()
  where client_id = p_client_id;

  insert into audit_log (action, details, actor)
  values ('تعديل جولة وإعادتها للاعتماد',
          (p->>'date') || ' — ' || coalesce(p->>'hospital','') || ' / ' || coalesce(p->>'department',''), v_name);
  return 'ok';
end $$;

-- ============================================================
-- 6) صلاحيات التنفيذ (المجهول لا يصل إلا عبر هذه الدوال)
-- ============================================================
revoke execute on function verify_manager_code(text)                    from public;
revoke execute on function manager_list_reports(text)                   from public;
revoke execute on function manager_approve_report(text, text, text)     from public;
revoke execute on function manager_reject_report(text, text, text)      from public;
revoke execute on function manager_return_report(text, text, text)      from public;
revoke execute on function get_my_reports(text)                         from public;
revoke execute on function update_my_report(text, text, jsonb)          from public;

grant execute on function verify_manager_code(text)                     to anon, authenticated;
grant execute on function manager_list_reports(text)                    to anon, authenticated;
grant execute on function manager_approve_report(text, text, text)      to anon, authenticated;
grant execute on function manager_reject_report(text, text, text)       to anon, authenticated;
grant execute on function manager_return_report(text, text, text)       to anon, authenticated;
grant execute on function get_my_reports(text)                          to anon, authenticated;
grant execute on function update_my_report(text, text, jsonb)           to anon, authenticated;
