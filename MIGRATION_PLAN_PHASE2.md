# خطة الترحيل — المرحلة 2: الربط السحابي بـ Supabase
**الحالة:** خطة للمراجعة فقط — لم يُعدَّل أي شيء · **التاريخ:** 2026-07-06

## المبدأ المعماري المقترح (يحدد كل ما يلي)

**محلي-أولاً مع مزامنة خلفية (Local-first + Sync)** بدل تحويل كل الكود إلى async:
localStorage يبقى ذاكرة العمل التي تقرأ منها كل الشاشات كما هي اليوم (لا تغيير على دوال العرض)، وتُضاف طبقة `Sync` تسحب من Supabase عند الفتح وكل 60 ثانية وتدفع الكتابات عبر صف انتظار (outbox) يعيد المحاولة عند عودة الاتصال. Supabase هو مصدر الحقيقة، والمتصفح كاش.

**مفتاح أمان التشغيل:** إن بقي `config.js` بقيمه النائبة (placeholder) يعمل النظام بوضع localStorage الحالي تماماً — أي أن نشر الكود الجديد قبل تجهيز Supabase لا يكسر شيئاً.

---

## 1. الملفات التي ستتعدل

| الملف | نوع التغيير | التفصيل |
|---|---|---|
| `config.js` | تعديل | وضع Project URL و anon key الحقيقيين + بريد المسؤول الداخلي |
| `script.js` | تعديل (الأكبر) | إضافة وحدة `Sync` (سحب/دفع/outbox)، تحويل دخول المسؤول إلى Supabase Auth، دخول الموظف عبر RPC، تحويل أسماء الحقول (`leave` ↔ `leave_count`)، زر «رفع البيانات المحلية» يظهر مرة واحدة، كتابة التدقيق للسحابة |
| `admin.html` | تعديل طفيف | سطران: `<script>` لمكتبة supabase-js v2 من CDN + `config.js` |
| `employee.html` | تعديل طفيف | السطران نفسهما |
| `index.html` | تعديل طفيف | السطران نفسهما (لمؤشر حالة الاتصال) |
| `sw.js` | تعديل طفيف | رفع رقم إصدار الكاش + استثناء طلبات `*.supabase.co` من التخزين المؤقت (بيانات حية لا تُكاش) |
| `supabase-schema.sql` | استبدال كامل | النسخة v2 الآمنة (القسم 3) |
| `README.md` | تعديل | تحديث خطوات الإعداد |

**واجهة المستخدم لن تتغير:** شاشة دخول المسؤول تبقى كلمة مرور فقط — البريد يُثبَّت داخلياً في config.js ويُستخدم خلف الكواليس مع `signInWithPassword`. شاشة الموظف تبقى كوداً فقط. تُضاف فقط شارة صغيرة «متصل/غير متصل» (اختيارية — أقدر إلغاءها إن اعتبرتها تغيير واجهة).

## 2. جداول Supabase التي ستتغير

المشروع السحابي المفترض **جديد وفارغ** (المحاولة السابقة أُلغيت قبل الاستخدام). مقارنةً بملف `supabase-schema.sql` الحالي في المستودع:

| الجدول | التغيير | السبب |
|---|---|---|
| `settings` | **يُحذف نهائياً** | كان يخزّن كلمة مرور المسؤول نصاً واضحاً — تنتقل المصادقة إلى Supabase Auth |
| `reports` | إضافة أعمدة: `approved_by`, `approver_title`, `sig_id`, `client_id` (فريد — لمنع ازدواج المزامنة), `updated_at` | دعم ميزات التوقيع الحالية + مزامنة آمنة قابلة للإعادة |
| `signatures` | **جديد**: `id, data_url, created_at` | السجل المرجعي للتوقيعات (كما نُفذ محلياً في المرحلة 1) |
| `audit_log` | **جديد**: `id, at, action, details, actor` — إدراج فقط (append-only) | سجل تدقيق لا يمكن مسحه من المتصفح |
| `employees`, `departments`, `shifts` | بلا تغيير بنيوي — تضاف `client_id` فريدة فقط | مزامنة قابلة للإعادة |
| **RLS (الأهم)** | استبدال سياسات `using (true)` الخمس بالكامل | إغلاق الثغرة S5 |

نموذج الصلاحيات الجديد: **المجهول (anon)** يقرأ الأقسام فقط ويستدعي دالتي RPC، **المسؤول الموثَّق** صلاحيات كاملة عدا تعديل/حذف سجل التدقيق. إدخال التقارير لا يتم مباشرة أبداً بل عبر RPC تتحقق من كود الموظف.

## 3. أوامر SQL التي ستُنفَّذ (كاملة، في SQL Editor بمشروع Supabase)

```sql
-- ===== v2: يُنفَّذ على مشروع جديد (أو بعد حذف جداول المحاولة القديمة إن وُجدت) =====
create extension if not exists "pgcrypto";
drop table if exists settings;  -- إزالة تخزين كلمة المرور نهائياً

-- الجداول (كما في v1 مع الأعمدة الجديدة)
create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  client_id text unique, name text not null, hospital text not null,
  created_at timestamptz not null default now());

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  client_id text unique, name text not null, code text not null unique,
  hospital text, created_at timestamptz not null default now());

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  client_id text unique, hospital text not null, department text not null,
  period text not null, required_count integer not null default 0,
  created_at timestamptz not null default now());

create table if not exists signatures (
  id uuid primary key default gen_random_uuid(),
  client_id text unique, data_url text not null,
  created_at timestamptz not null default now());

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  client_id text unique,
  date date not null, day text, period text, hospital text, department text,
  total int default 0, present int default 0, absent int default 0,
  withdrawn int default 0, leave_count int default 0,
  absent_names text, notes text, entered_by text, employee_code text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  rejection_reason text, approved_by text, approver_title text, sig_id text,
  created_at timestamptz not null default now(),
  approved_at timestamptz, rejected_at timestamptz, updated_at timestamptz default now());

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null, details text, actor text);

create index if not exists idx_reports_date     on reports(date);
create index if not exists idx_reports_status   on reports(status);
create index if not exists idx_reports_hospital on reports(hospital);

-- ===== RLS =====
alter table departments enable row level security;
alter table employees   enable row level security;
alter table shifts      enable row level security;
alter table signatures  enable row level security;
alter table reports     enable row level security;
alter table audit_log   enable row level security;

-- المجهول: قراءة الأقسام فقط (يحتاجها نموذج الموظف)
create policy "anon read departments" on departments for select to anon using (true);

-- المسؤول الموثَّق: كل شيء
create policy "auth all departments" on departments for all to authenticated using (true) with check (true);
create policy "auth all employees"   on employees   for all to authenticated using (true) with check (true);
create policy "auth all shifts"      on shifts      for all to authenticated using (true) with check (true);
create policy "auth all signatures"  on signatures  for all to authenticated using (true) with check (true);
create policy "auth all reports"     on reports     for all to authenticated using (true) with check (true);
-- التدقيق: قراءة وإدراج فقط — لا تعديل ولا حذف حتى للمسؤول
create policy "auth read audit"   on audit_log for select to authenticated using (true);
create policy "auth insert audit" on audit_log for insert to authenticated with check (true);

-- ===== دوال RPC (SECURITY DEFINER — تتجاوز RLS بعد تحقق داخلي) =====
-- تحقق كود الموظف: يعيد الاسم فقط، لا يكشف بقية البيانات
create or replace function verify_employee_code(p_code text)
returns table(name text, hospital text)
language sql security definer set search_path = public as $$
  select name, hospital from employees where upper(code) = upper(trim(p_code)) limit 1;
$$;

-- إدخال تقرير: يتحقق من الكود ويمنع التكرار ثم يدرج (المجهول لا يملك insert مباشراً)
create or replace function submit_report(p_code text, p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select name into v_name from employees where upper(code) = upper(trim(p_code));
  if v_name is null then return 'invalid_code'; end if;
  if exists (select 1 from reports where date = (p->>'date')::date
      and hospital = p->>'hospital' and department = p->>'department'
      and period = p->>'period' and status <> 'rejected') then
    return 'duplicate';
  end if;
  insert into reports (client_id, date, day, period, hospital, department, total, present,
    absent, withdrawn, leave_count, absent_names, notes, entered_by, employee_code)
  values (p->>'client_id', (p->>'date')::date, p->>'day', p->>'period', p->>'hospital',
    p->>'department', coalesce((p->>'total')::int,0), coalesce((p->>'present')::int,0),
    coalesce((p->>'absent')::int,0), coalesce((p->>'withdrawn')::int,0),
    coalesce((p->>'leave')::int,0), p->>'absentNames', p->>'notes', v_name, upper(trim(p_code)))
  on conflict (client_id) do nothing;
  insert into audit_log (action, details, actor)
    values ('إدخال تقرير', (p->>'date') || ' — ' || (p->>'hospital') || ' / ' || (p->>'department'), v_name);
  return 'ok';
end $$;

grant execute on function verify_employee_code(text) to anon;
grant execute on function submit_report(text, jsonb) to anon;
```

إضافة إلى SQL: إنشاء **مستخدم المسؤول** من لوحة Supabase (Authentication ← Add user) ببريد داخلي مثل `admin@mksh.local` وكلمة مرور قوية — بلا SQL.

## 4. هل ستتأثر البيانات الموجودة؟

**البيانات المحلية (localStorage): لا تُمسّ إطلاقاً.** تبقى كما هي وتصبح الكاش المحلي. بعد أول دخول للمسؤول تظهر رسالة لمرة واحدة: «رفع البيانات المحلية إلى السحابة» ترفع الموظفين والأقسام والجداول والتقارير والتوقيعات بمعرفاتها المحلية (`client_id`) — إعادة تشغيل الرفع آمنة (upsert، لا ازدواج). **السحابة: المشروع جديد وفارغ، لا بيانات سابقة تتأثر.** ملف النسخة الاحتياطية JSON يبقى متوافقاً بالاتجاهين.

**نقطة انتباه وحيدة:** تقارير أُدخلت على أجهزة أخرى (جوالات موظفين) قبل الترحيل محبوسة في متصفحات أصحابها ولن تنتقل تلقائياً — تنتقل فقط بيانات المتصفح الذي يضغط زر الرفع. عملياً بياناتك الحقيقية في متصفح المسؤول، فالأثر شبه معدوم.

## 5. هل سيحدث توقف للموقع؟

**لا — صفر توقف مخطط.** الأسباب: (أ) الموقع ثابت على GitHub Pages والنشر استبدال ذري يكتمل خلال ~دقيقة، (ب) ترتيب التنفيذ يجهّز Supabase بالكامل ويختبره **قبل** دفع الكود، (ج) حارس config.js: أي خلل في السحابة يجعل النظام يعمل تلقائياً بوضع localStorage الحالي، (د) Service Worker يخدم النسخة القديمة من الكاش حتى اكتمال تحميل الجديدة.

ترتيب التنفيذ الفعلي: نسخة احتياطية JSON ← إنشاء مشروع Supabase وتنفيذ SQL وإنشاء مستخدم المسؤول ← اختبار الكود الجديد محلياً على المشروع ← الدفع إلى GitHub ← دخول المسؤول ورفع البيانات المحلية ← تجربة إدخال تقرير من جهاز ثانٍ والتأكد من وصوله.

## 6. خطة التراجع (Rollback)

| السيناريو | الإجراء | الوقت |
|---|---|---|
| خلل بعد النشر (أي نوع) | `git revert` لِـ commit المرحلة 2 ثم push — تعود Pages للنسخة الحالية العاملة | ~دقيقتان |
| Supabase معطّل أو بطيء | لا إجراء — الحارس يعيد النظام لوضع localStorage تلقائياً، وصف الانتظار يزامن عند عودة الخدمة | تلقائي |
| بيانات سحابية فاسدة (رفع خاطئ) | إفراغ الجداول (`truncate`) وإعادة الرفع من زر الرفع أو من النسخة الاحتياطية JSON | ~10 دقائق |
| تراجع كامل عن المرحلة 2 | revert الكود + إيقاف مشروع Supabase مؤقتاً (Pause) — البيانات المحلية لم تُمسّ أصلاً فيعود كل شيء كما اليوم | ~5 دقائق |

قبل أي تنفيذ سأنشئ وسم git ‏(`v2.0-pre-supabase`) على الـ commit الحالي ليكون نقطة عودة مسماة، وأطلب منك تنزيل نسخة احتياطية JSON من الإعدادات.

---

## ما أحتاجه منك للتنفيذ عند الموافقة

1. إنشاء حساب/مشروع مجاني على supabase.com (أو أرشدك خطوة بخطوة، أو تعطيني وصولاً)، ومنه: Project URL و anon key وتنفيذ SQL أعلاه.
2. كلمة مرور قوية لمستخدم المسؤول (تُدخلها أنت في لوحة Supabase — لا تشاركها معي).
3. رمز GitHub جديد للدفع عند الجاهزية.
4. قرارك بشأن شارة «متصل/غير متصل» (إضافة مقبولة أم تُعد تغيير واجهة؟).

**لن أنفذ شيئاً حتى موافقتك الصريحة.**
