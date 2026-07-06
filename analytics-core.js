/* ============================================================
   الطبقة التحليلية المشتركة — analytics-core.js
   ------------------------------------------------------------
   مكوّنات قابلة لإعادة الاستخدام تتشاركها وحدات المنصة
   (خريطة العمليات — المرحلة 5، ومركز القيادة — المرحلة 10)
   بهدف منع تكرار الكود وتوحيد الحسابات.

   تعتمد على الطبقات القائمة في script.js دون تعديلها:
     DB (ذاكرة العمل) · Cloud (Supabase) · Sync (السحب/الدفع)

   تُحمَّل بعد script.js وقبل وحدة الصفحة:
     config.js → script.js → analytics-core.js → <module>.js
   ============================================================ */

'use strict';

/* ======================================================
   Analytics — حسابات موحّدة (كلها من البيانات الفعلية)
   ====================================================== */
const Analytics = {

  /* حدود ألوان الحالة: أخضر ≥95، أصفر 85–94، أحمر <85 */
  THRESHOLDS: { green: 95, yellow: 85 },

  /* عتبة غياب الأقسام (تنبيه إذا تجاوزها القسم) */
  ABSENCE_THRESHOLD: 15,

  /* بيانات عرض المستشفيات (أيقونة/لون/إحداثيات تقريبية للمدينة المنورة) */
  HOSPITAL_META: {
    'مستشفى المدينة الرئيسي':  { icon: 'fa-hospital', color: '#2980b9', en: 'Main Hospital',                coords: [24.4861, 39.5799] },
    'مستشفى النساء والأطفال': { icon: 'fa-baby',     color: '#8e44ad', en: 'Maternity & Children Hospital', coords: [24.4838, 39.5758] },
    'مستشفى الطب النفسي':     { icon: 'fa-brain',    color: '#16a085', en: 'Mental Health Hospital',        coords: [24.4895, 39.5846] },
  },

  /* ---- تجميع تقارير: حاضر/غائب/إجازة/منسحب + نسبة الحضور ---- */
  sumStats(reports) {
    const t = reports.reduce((a, r) => {
      a.present   += +r.present   || 0;
      a.absent    += +r.absent    || 0;
      a.withdrawn += +r.withdrawn || 0;
      a.leave     += +r.leave     || 0;
      return a;
    }, { present: 0, absent: 0, withdrawn: 0, leave: 0 });
    const denom = t.present + t.absent + t.withdrawn + t.leave;
    return {
      ...t,
      denom,
      rate:        denom ? (t.present / denom) * 100 : null,  // null = لا بيانات
      absenceRate: denom ? (t.absent  / denom) * 100 : null,
      count: reports.length,
    };
  },

  /* ---- تصنيف الحالة اللونية حسب نسبة الحضور ---- */
  statusOf(rate) {
    if (rate === null)                  return { cls: 'status-none',   label: 'لا توجد بيانات', emoji: '⚪' };
    if (rate >= this.THRESHOLDS.green)  return { cls: 'status-green',  label: 'ممتاز',          emoji: '🟢' };
    if (rate >= this.THRESHOLDS.yellow) return { cls: 'status-yellow', label: 'يحتاج متابعة',   emoji: '🟡' };
    return                                     { cls: 'status-red',    label: 'حرج',            emoji: '🔴' };
  },

  /* ---- التقارير ضمن نطاق (المرفوضة مستبعدة دائماً) ---- */
  reports({ from, to, hospital = null, department = null } = {}) {
    let list = DB.getReports().filter(r =>
      r.date >= from && r.date <= to && r.status !== 'rejected');
    if (hospital)   list = list.filter(r => r.hospital === hospital);
    if (department) list = list.filter(r => r.department === department);
    return list;
  },

  /* ---- نطاقات الفلاتر السريعة ---- */
  rangeFor(preset) {
    const t = new Date();
    const iso = d => DB.localISO(d);
    switch (preset) {
      case 'today':     return { from: DB.today(), to: DB.today() };
      case 'yesterday': { const y = new Date(t); y.setDate(t.getDate() - 1); return { from: iso(y), to: iso(y) }; }
      case 'week':      return DB.weekRange();
      case 'month':     return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)),
                                 to:   iso(new Date(t.getFullYear(), t.getMonth() + 1, 0)) };
      case 'quarter': {
        const q = Math.floor(t.getMonth() / 3);
        return { from: iso(new Date(t.getFullYear(), q * 3, 1)),
                 to:   iso(new Date(t.getFullYear(), q * 3 + 3, 0)) };
      }
      case 'year':      return { from: `${t.getFullYear()}-01-01`, to: `${t.getFullYear()}-12-31` };
      default:          return { from: DB.today(), to: DB.today() };
    }
  },

  /* ---- الفترة السابقة المساوية في الطول (للمقارنات) ---- */
  prevRange(from, to) {
    const f = new Date(from + 'T00:00:00'), x = new Date(to + 'T00:00:00');
    const span = Math.round((x - f) / 86400000) + 1;
    const pTo = new Date(f); pTo.setDate(f.getDate() - 1);
    const pFrom = new Date(pTo); pFrom.setDate(pTo.getDate() - (span - 1));
    return { from: DB.localISO(pFrom), to: DB.localISO(pTo) };
  },

  /* ---- قائمة أيام النطاق (بسقف حماية للأداء) ---- */
  days(from, to, cap = 370) {
    const out = [];
    const d = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
    while (d <= end && out.length < cap) { out.push(DB.localISO(d)); d.setDate(d.getDate() + 1); }
    return out;
  },

  /* ======================================================
     نسبة الالتزام (Compliance)
     المتوقع = جداول الدوام المعرّفة × أيام النطاق
     المُغطّى = خانات (يوم/مستشفى/قسم/فترة) وصلها تقرير
     بحث عبر Set — O(أيام×جداول) بلا تداخل مع التقارير
     ====================================================== */
  compliance({ from, to, hospital = null } = {}) {
    let shifts = DB.getShifts();
    if (hospital) shifts = shifts.filter(s => s.hospital === hospital);
    const days = this.days(from, to);
    const expected = shifts.length * days.length;
    const reps = this.reports({ from, to, hospital });
    if (!expected) return { expected: 0, covered: 0, missing: null, rate: null, submitted: reps.length };

    const have = new Set(reps.map(r => `${r.date}|${r.hospital}|${r.department}|${r.period}`));
    let covered = 0;
    for (const day of days)
      for (const s of shifts)
        if (have.has(`${day}|${s.hospital}|${s.department}|${s.period}`)) covered++;

    return {
      expected, covered,
      missing: expected - covered,
      rate: (covered / expected) * 100,
      submitted: reps.length,
    };
  },

  /* ======================================================
     رسم Chart.js موحّد — يدمّر النسخة السابقة ويطبّق السمة
     registry: كائن تحتفظ به الوحدة المستدعية
     ====================================================== */
  chart(registry, id, config) {
    const cv = document.getElementById(id);
    if (!cv || typeof Chart === 'undefined') return;
    if (registry[id]) registry[id].destroy();
    Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--text-light').trim();
    Chart.defaults.font.family = 'Cairo, sans-serif';
    registry[id] = new Chart(cv.getContext('2d'), config);
  },

  /* ======================================================
     تحديث تلقائي عند وصول بيانات جديدة (مشترك بين الصفحات)
     - سحابة: قناة Supabase Realtime على جدول reports
     - محلي : حدث storage من تبويب آخر
     - شبكة أمان: سحب دوري + تحديث عند العودة للتبويب
     ====================================================== */
  autoRefresh(channelName, onChange) {
    let debounce = null;
    const fire = () => { clearTimeout(debounce); debounce = setTimeout(onChange, 800); };

    if (Cloud.on()) {
      try {
        Cloud.sb.channel(channelName)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' }, fire)
          .subscribe();
      } catch { /* Realtime غير مفعّل — يكفي السحب الدوري */ }
    }
    window.addEventListener('storage', e => { if (e.key === DB._k.reports) fire(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange(); });
    return setInterval(onChange, 60000);
  },

  /* ---- سحب أحدث البيانات من Supabase (المصدر الوحيد للحقيقة) ---- */
  async pull() {
    if (Cloud.on()) {
      try { await Sync.pullAll(); } catch { /* دون اتصال — آخر نسخة معروفة */ }
    }
  },
};

/* ======================================================
   AdminGate — بوابة دخول المسؤول (مكوّن مشترك)
   نفس منطق لوحة المسؤول: Supabase Auth إن فُعّلت السحابة،
   وإلا كلمة المرور المحلية المشفرة.
   ids: { overlay, input, error } · onReady: تُستدعى بعد الدخول
   ====================================================== */
const AdminGate = {
  init(ids, onReady) {
    if (DB.isAdminLoggedIn()) { onReady(); return; }
    const ov = document.getElementById(ids.overlay);
    if (ov) ov.style.display = 'flex';
    document.getElementById(ids.input)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.login(ids, onReady);
    });
    // استعادة جلسة سحابية محفوظة
    if (Cloud.on()) {
      Cloud.sb.auth.getSession().then(({ data }) => {
        if (data?.session) { DB.setAdminSession(); onReady(); }
      }).catch(() => {});
    }
  },

  async login(ids, onReady) {
    const inp = document.getElementById(ids.input);
    const err = document.getElementById(ids.error);
    if (!inp || !err) return;

    let ok;
    if (Cloud.on()) {
      try {
        const { error } = await Cloud.sb.auth.signInWithPassword({
          email: SUPABASE_CONFIG.adminEmail, password: inp.value,
        });
        ok = !error;
      } catch { ok = false; }
    } else {
      ok = await DB.verifyPass(inp.value);
    }

    if (ok) {
      DB.setAdminSession();
      DB.audit('تسجيل دخول المسؤول', 'دخول عبر ' + (document.title || 'صفحة تحليلية'));
      err.classList.remove('show');
      onReady();
    } else {
      err.classList.add('show');
      inp.value = '';
      inp.focus();
    }
  },

  logout(redirect = 'index.html') {
    const bye = () => { DB.clearAdminSession(); location.href = redirect; };
    if (Cloud.on()) Cloud.sb.auth.signOut().then(bye).catch(bye);
    else bye();
  },
};
