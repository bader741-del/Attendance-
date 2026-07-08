-- ============================================================
-- منصة مراقبة الدوام - مدينة الملك سلمان الطبية
-- مخطط قاعدة البيانات v2 — Supabase (PostgreSQL)
-- أمان قائم على الأدوار: RLS مفعّل على كل الجداول، لا سياسات مفتوحة
-- ============================================================
-- طريقة الاستخدام:
-- 1) أنشئ مشروعاً على supabase.com
-- 2) SQL Editor ← الصق الملف كاملاً ← Run
-- 3) Authentication ← Add user ← أنشئ مستخدم المسؤول
--    (البريد نفسه الموجود في config.js، بكلمة مرور قوية)
-- 4) نفّذ الخطوة الأخيرة أسفل الملف (تسجيل المسؤول في admin_users)
-- 5) انسخ Project URL و anon key من Settings > API إلى config.js
-- ============================================================

create extension if not exists "pgcrypto";

-- إزالة جدول كلمة المرور من النسخة القديمة إن وُجد (المصادقة الآن عبر Supabase Auth)
drop table if exists settings;

-- ============================================================
-- الأدوار: من هو المسؤول؟
-- ============================================================
create table if not exists admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);

-- دالة فحص الدور — تُستخدم في كل السياسات أدناه
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admin_users where user_id = auth.uid());
$$;

-- ============================================================
-- الجداول
-- ============================================================
create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  name text not null,
  hospital text not null,
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  name text not null,
  code text not null unique,
  hospital text,
  created_at timestamptz not null default now()
);

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  hospital text not null,
  department text not null,
  period text not null,
  required_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists signatures (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  data_url text not null,
  created_at timestamptz not null default now()
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  date date not null,
  day text,
  period text,
  hospital text,
  department text,
  total integer default 0,
  present integer default 0,
  absent integer default 0,
  withdrawn integer default 0,
  leave_count integer default 0,
  absent_names text,
  notes text,
  entered_by text,
  employee_code text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  rejection_reason text,
  approved_by text,
  approver_title text,
  sig_id text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null,
  details text,
  actor text
);

create index if not exists idx_reports_date     on reports(date);
create index if not exists idx_reports_status   on reports(status);
create index if not exists idx_reports_hospital on reports(hospital);
create index if not exists idx_employees_code   on employees(code);
create index if not exists idx_departments_hosp on departments(hospital);

-- ============================================================
-- RLS — مفعّل على كل جدول، والوصول حسب الدور فقط
-- ============================================================
alter table admin_users enable row level security;
alter table departments enable row level security;
alter table employees   enable row level security;
alter table shifts      enable row level security;
alter table signatures  enable row level security;
alter table reports     enable row level security;
alter table audit_log   enable row level security;

-- admin_users: المسؤول يقرأ سجله فقط (الإدارة عبر لوحة Supabase حصراً)
create policy "admin read own role" on admin_users
  for select to authenticated using (user_id = auth.uid());

-- departments: قراءة عامة (يحتاجها نموذج الموظف — أسماء أقسام فقط، غير حساسة)
-- والكتابة للمسؤول حصراً
create policy "public read departments" on departments
  for select to anon, authenticated using (true);
create policy "admin insert departments" on departments
  for insert to authenticated with check (is_admin());
create policy "admin update departments" on departments
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete departments" on departments
  for delete to authenticated using (is_admin());

-- employees: بيانات حساسة (أسماء + أكواد دخول) — المسؤول فقط، لا وصول للمجهول
-- التحقق من الكود يتم عبر RPC أدناه دون كشف الجدول
create policy "admin select employees" on employees
  for select to authenticated using (is_admin());
create policy "admin insert employees" on employees
  for insert to authenticated with check (is_admin());
create policy "admin update employees" on employees
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete employees" on employees
  for delete to authenticated using (is_admin());

-- shifts: المسؤول فقط
create policy "admin select shifts" on shifts
  for select to authenticated using (is_admin());
create policy "admin insert shifts" on shifts
  for insert to authenticated with check (is_admin());
create policy "admin update shifts" on shifts
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete shifts" on shifts
  for delete to authenticated using (is_admin());

-- signatures: توقيع النائب الإداري — المسؤول فقط
create policy "admin select signatures" on signatures
  for select to authenticated using (is_admin());
create policy "admin insert signatures" on signatures
  for insert to authenticated with check (is_admin());
create policy "admin update signatures" on signatures
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete signatures" on signatures
  for delete to authenticated using (is_admin());

-- reports: بيانات حساسة (أسماء متغيبين) — المسؤول فقط
-- إدخال الموظفين يتم حصراً عبر RPC (security definer) بعد التحقق من الكود
create policy "admin select reports" on reports
  for select to authenticated using (is_admin());
create policy "admin insert reports" on reports
  for insert to authenticated with check (is_admin());
create policy "admin update reports" on reports
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete reports" on reports
  for delete to authenticated using (is_admin());

-- audit_log: سجل غير قابل للتعديل — المسؤول يقرأ ويضيف، لا update/delete لأحد
create policy "admin select audit" on audit_log
  for select to authenticated using (is_admin());
create policy "admin insert audit" on audit_log
  for insert to authenticated with check (is_admin());

-- ============================================================
-- دوال RPC — المنفذ الوحيد للمجهول (الموظف)
-- security definer: تتجاوز RLS بعد تحقق داخلي صريح من الكود
-- ============================================================

-- تحقق كود الموظف: يعيد الاسم والمستشفى فقط — لا يكشف الأكواد أو بقية الصفوف
create or replace function verify_employee_code(p_code text)
returns table(name text, hospital text)
language sql stable security definer set search_path = public as $$
  select name, hospital from employees
  where upper(code) = upper(trim(p_code))
  limit 1;
$$;

-- إدخال تقرير: تحقق من الكود + منع التكرار + إدراج + تدقيق، ذرّياً
create or replace function submit_report(p_code text, p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text;
begin
  select name into v_name from employees where upper(code) = upper(trim(p_code));
  if v_name is null then
    return 'invalid_code';
  end if;

  if exists (
    select 1 from reports
    where date = (p->>'date')::date
      and hospital   = p->>'hospital'
      and department = p->>'department'
      and period     = p->>'period'
      and status <> 'rejected'
  ) then
    return 'duplicate';
  end if;

  insert into reports (client_id, date, day, period, hospital, department,
    total, present, absent, withdrawn, leave_count,
    absent_names, notes, entered_by, employee_code)
  values (
    p->>'client_id', (p->>'date')::date, p->>'day', p->>'period',
    p->>'hospital', p->>'department',
    coalesce((p->>'total')::int, 0), coalesce((p->>'present')::int, 0),
    coalesce((p->>'absent')::int, 0), coalesce((p->>'withdrawn')::int, 0),
    coalesce((p->>'leave')::int, 0),
    p->>'absentNames', p->>'notes', v_name, upper(trim(p_code))
  )
  on conflict (client_id) do nothing;

  insert into audit_log (action, details, actor)
  values ('إدخال تقرير',
          (p->>'date') || ' — ' || coalesce(p->>'hospital','') || ' / ' || coalesce(p->>'department',''),
          v_name);
  return 'ok';
end $$;

-- صلاحية التنفيذ للمجهول على الدالتين فقط
revoke execute on function verify_employee_code(text) from public;
revoke execute on function submit_report(text, jsonb) from public;
grant execute on function verify_employee_code(text) to anon, authenticated;
grant execute on function submit_report(text, jsonb) to anon, authenticated;

-- ============================================================
-- الخطوة الأخيرة (بعد إنشاء مستخدم المسؤول من Authentication):
-- عدّل البريد ليطابق ما أنشأته ثم نفّذ هذا السطر وحده:
-- ============================================================
-- insert into admin_users (user_id, note)
--   select id, 'المسؤول الرئيسي' from auth.users where email = 'admin@mksh.local'
--   on conflict (user_id) do nothing;

-- ============================================================
-- بعد تنفيذ هذا الملف: نفّذ أيضاً ملفي نظام اعتماد الجولات بالترتيب:
--   1) supabase-approvals-migration.sql
--      (حقول الاعتماد، جدول مدراء المناوبة، دوال الاعتماد/الرفض/الإرجاع)
--   2) supabase-rounds-migration.sql
--      (جولة متعددة الأقسام: rounds + round_sections + اعتماد الجولة كاملة)
-- ============================================================
