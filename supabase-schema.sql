-- ============================================================
-- منصة مراقبة الدوام - مدينة الملك سلمان الطبية
-- مخطط قاعدة بيانات Supabase (PostgreSQL)
-- ============================================================
-- طريقة الاستخدام:
-- 1) أنشئ مشروعاً جديداً على supabase.com
-- 2) افتح SQL Editor في لوحة تحكم المشروع
-- 3) الصق هذا الملف بالكامل ونفّذه (Run)
-- 4) انسخ Project URL و anon public key من Settings > API
--    وضعهما في ملف config.js
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- جدول الإعدادات (كلمة مرور المسؤول) ----------
create table if not exists settings (
  id integer primary key default 1,
  admin_password text not null default 'admin1234',
  constraint single_row check (id = 1)
);
insert into settings (id, admin_password) values (1, 'admin1234')
  on conflict (id) do nothing;

-- ---------- جدول الأقسام ----------
create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hospital text not null,
  created_at timestamptz not null default now()
);

-- ---------- جدول الموظفين (الأكواد) ----------
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  hospital text,
  department text,
  created_at timestamptz not null default now()
);

-- إن كان هذا الجدول قد أُنشئ سابقاً بدون عمود القسم، أضفه الآن (آمن للتنفيذ المتكرر)
alter table employees add column if not exists department text;

-- ---------- جدول جداول الدوام ----------
create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  hospital text not null,
  department text not null,
  period text not null,
  required_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- جدول التقارير ----------
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
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
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz
);

create index if not exists idx_reports_date on reports(date);
create index if not exists idx_reports_status on reports(status);
create index if not exists idx_reports_hospital on reports(hospital);
create index if not exists idx_departments_hospital on departments(hospital);
create index if not exists idx_employees_code on employees(code);

-- ============================================================
-- سياسات الوصول (RLS)
-- ملاحظة أمنية مهمة: النظام لا يحتوي على مصادقة مستخدمين حقيقية
-- على مستوى قاعدة البيانات (لا يوجد Supabase Auth) — الحماية الوحيدة
-- هي كلمة مرور تُتحقق منها من المتصفح، تماماً كما كان الحال مع
-- localStorage. لذلك هذه السياسات تسمح بالقراءة/الكتابة لأي شخص يملك
-- مفتاح anon (وهو مفتاح "عام" مخصص لهذا الغرض في Supabase، وليس سرياً
-- بحد ذاته). هذا مناسب لتطبيق داخلي محدود الاستخدام، لكنه ليس بديلاً
-- عن نظام مصادقة حقيقي إذا أردتم أماناً أعلى مستقبلاً.
-- ============================================================

alter table settings enable row level security;
alter table departments enable row level security;
alter table employees enable row level security;
alter table shifts enable row level security;
alter table reports enable row level security;

create policy "allow all on settings"    on settings    for all using (true) with check (true);
create policy "allow all on departments" on departments for all using (true) with check (true);
create policy "allow all on employees"   on employees   for all using (true) with check (true);
create policy "allow all on shifts"      on shifts      for all using (true) with check (true);
create policy "allow all on reports"     on reports     for all using (true) with check (true);
