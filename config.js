/* ============================================================
   إعدادات الاتصال بـ Supabase
   من: Supabase Dashboard > Settings > API
   ------------------------------------------------------------
   ما دامت القيم النائبة (YOUR-...) موجودة، تعمل المنصة بوضع
   التخزين المحلي (localStorage) تماماً كما قبل الربط السحابي.
   ============================================================ */
const SUPABASE_CONFIG = {
  url: 'https://mtrifnjcunkalldkddvb.supabase.com',
  anonKey: 'sb_publishable_yOfjjPkItn9jIl8tyUOVPg_An9XsFUI',
  /* بريد مستخدم المسؤول في Supabase Auth — يُستخدم داخلياً خلف
     شاشة الدخول الحالية (التي تطلب كلمة المرور فقط) */
  adminEmail: 'admin@mksh.local',
};

/* حارس التفعيل: صحيح فقط عند وضع قيم حقيقية */
const CLOUD_ENABLED =
  typeof SUPABASE_CONFIG !== 'undefined' &&
  !SUPABASE_CONFIG.url.includes('YOUR-PROJECT-REF') &&
  !SUPABASE_CONFIG.anonKey.includes('YOUR-ANON');
