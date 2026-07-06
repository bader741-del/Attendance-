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

  /* ---- التقارير ضمن نطاق (المرفوضة مستبعدة دائماً) ----
     فلاتر اختيارية: مستشفى / قسم / موظف (بالكود) / حالة الاعتماد */
  reports({ from, to, hospital = null, department = null, employee = null, status = null } = {}) {
    let list = DB.getReports().filter(r =>
      r.date >= from && r.date <= to && r.status !== 'rejected');
    if (hospital)   list = list.filter(r => r.hospital === hospital);
    if (department) list = list.filter(r => r.department === department);
    if (employee)   list = list.filter(r => (r.employeeCode || '').toUpperCase() === employee.toUpperCase());
    if (status)     list = list.filter(r => r.status === status);
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
     النظرة الشاملة (overview) — سياق تحليلي كامل يُحسب مرة
     واحدة ويغذي كل اللوحات. تستخدمه لوحة القيادة (المرحلة 10)
     ونظام التقارير (المرحلة 15) — بلا تكرار كود.
     opts: { from, to, hospital?, department?, employee?, status? }
     ====================================================== */
  overview(opts) {
    const { from, to } = opts;
    const prev = this.prevRange(from, to);
    const filt = {
      hospital:   opts.hospital   || null,
      department: opts.department || null,
      employee:   opts.employee   || null,
      status:     opts.status     || null,
    };

    const reps     = this.reports({ from, to, ...filt });
    const prevReps = this.reports({ from: prev.from, to: prev.to, ...filt });
    const stats     = this.sumStats(reps);
    const prevStats = this.sumStats(prevReps);
    const comp      = this.compliance({ from, to, hospital: filt.hospital });

    /* لكل مستشفى: إحصاء + التزام + موظفون + تقارير اليوم
       (تُشتق من reps المفلترة أصلاً — الفلاتر تسري تلقائياً) */
    const today = DB.today();
    const employees = DB.getEmployees();
    const hospitals = DB.HOSPITALS.map(h => ({
      name: h,
      stats: this.sumStats(reps.filter(r => r.hospital === h)),
      prevStats: this.sumStats(prevReps.filter(r => r.hospital === h)),
      comp: this.compliance({ from, to, hospital: h }),
      employees: employees.filter(e => e.hospital === h).length,
      todayReports: DB.getReports().filter(r => r.hospital === h && r.date === today && r.status !== 'rejected').length,
    }));

    /* لكل قسم: إحصاء الفترة + الفترة السابقة */
    const deptMap = {};
    const bucket = (list, key) => list.forEach(r => {
      if (!r.department) return;
      const id = `${r.hospital}|${r.department}`;
      (deptMap[id] ??= { hospital: r.hospital, department: r.department, cur: [], prv: [] })[key].push(r);
    });
    bucket(reps, 'cur'); bucket(prevReps, 'prv');
    const departments = Object.values(deptMap).map(d => ({
      ...d,
      stats: this.sumStats(d.cur),
      prevStats: this.sumStats(d.prv),
    }));

    const pendingAll = DB.getReports().filter(r =>
      r.date >= from && r.date <= to && r.status === 'pending' &&
      (!filt.hospital || r.hospital === filt.hospital) &&
      (!filt.department || r.department === filt.department)).length;

    return { from, to, prev, reps, prevReps, stats, prevStats, comp, hospitals, departments, pendingAll, today };
  },

  /* ======================================================
     الملاحظات/الرؤى الآلية — جُمل إدارية مولّدة من overview
     تُعيد مصفوفة { cls, icon, text } تعرضها أي واجهة
     ====================================================== */
  observations(ov, periodWord = 'الفترة السابقة') {
    const out = [];

    // تغير الحضور مقارنة بالفترة السابقة
    if (ov.stats.rate !== null && ov.prevStats.rate !== null) {
      const d = Math.round(ov.stats.rate - ov.prevStats.rate);
      if (d > 0)      out.push({ cls: 'up',   icon: 'fa-arrow-trend-up',   text: `ارتفعت نسبة الحضور بمقدار ${d} نقطة مقارنة بـ${periodWord} (${Math.round(ov.prevStats.rate)}% ← ${Math.round(ov.stats.rate)}%).` });
      else if (d < 0) out.push({ cls: 'down', icon: 'fa-arrow-trend-down', text: `انخفضت نسبة الحضور بمقدار ${Math.abs(d)} نقطة مقارنة بـ${periodWord} (${Math.round(ov.prevStats.rate)}% ← ${Math.round(ov.stats.rate)}%).` });
      else            out.push({ cls: '',     icon: 'fa-equals',           text: `نسبة الحضور مستقرة عند ${Math.round(ov.stats.rate)}% دون تغيّر عن ${periodWord}.` });
    }

    // الأعلى التزاماً برفع التقارير
    const withComp = ov.hospitals.filter(h => h.comp.rate !== null);
    if (withComp.length) {
      const best = withComp.reduce((a, b) => a.comp.rate >= b.comp.rate ? a : b);
      out.push({ cls: 'up', icon: 'fa-clipboard-check', text: `${best.name} الأعلى التزاماً برفع التقارير (${Math.round(best.comp.rate)}%).` });
    }

    // قسم يتطلب متابعة (الأدنى حضوراً وبعينة كافية)
    const deptsWithData = ov.departments.filter(d => d.stats.rate !== null && d.stats.denom >= 5);
    if (deptsWithData.length) {
      const worst = deptsWithData.reduce((a, b) => a.stats.rate <= b.stats.rate ? a : b);
      if (worst.stats.rate < this.THRESHOLDS.yellow)
        out.push({ cls: 'warn', icon: 'fa-circle-exclamation', text: `قسم ${worst.department} (${worst.hospital}) يتطلب متابعة — نسبة الحضور ${Math.round(worst.stats.rate)}%.` });
    }

    // القسم الأكثر تحسناً
    const improvable = ov.departments.filter(d => d.stats.rate !== null && d.prevStats.rate !== null);
    if (improvable.length) {
      const best = improvable.reduce((a, b) => (a.stats.rate - a.prevStats.rate) >= (b.stats.rate - b.prevStats.rate) ? a : b);
      const delta = Math.round(best.stats.rate - best.prevStats.rate);
      if (delta >= 3)
        out.push({ cls: 'up', icon: 'fa-arrow-trend-up', text: `قسم ${best.department} تحسّن بشكل ملحوظ (+${delta} نقطة مقارنة بالفترة السابقة).` });
    }

    // تقارير معلقة وخانات ناقصة
    if (ov.pendingAll)
      out.push({ cls: 'warn', icon: 'fa-hourglass-half', text: `${ov.pendingAll} تقرير بانتظار الاعتماد — يُنصح بمراجعتها لضمان دقة المؤشرات.` });
    if (ov.comp.missing)
      out.push({ cls: 'warn', icon: 'fa-file-circle-xmark', text: `${ov.comp.missing} خانة تقرير لم تُرفع خلال الفترة (نسبة الالتزام ${Math.round(ov.comp.rate)}%).` });

    return out;
  },

  /* ======================================================
     مصانع إعدادات Chart.js — إعداد واحد تستهلكه أي صفحة
     (لوحة القيادة، معاينة التقارير…) دون تكرار
     ====================================================== */
  chartCfg: {
    /* اتجاه الحضور: يومي حتى 62 يوماً وإلا تجميع شهري */
    trend(reps, from, to) {
      const allDays = Analytics.days(from, to);
      let labels, buckets;
      if (allDays.length <= 62) {
        labels = allDays.map(d => d.slice(5));
        buckets = allDays.map(d => reps.filter(r => r.date === d));
      } else {
        const byMonth = {};
        reps.forEach(r => (byMonth[r.date.slice(0, 7)] ??= []).push(r));
        const months = [...new Set(allDays.map(d => d.slice(0, 7)))];
        labels = months;
        buckets = months.map(m => byMonth[m] || []);
      }
      const per = buckets.map(b => Analytics.sumStats(b));
      return {
        type: 'line',
        data: { labels, datasets: [
          { label: 'حاضر', data: per.map(s => s.present), borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,.12)', fill: true, tension: .35 },
          { label: 'غائب', data: per.map(s => s.absent), borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,.10)', fill: true, tension: .35 },
        ]},
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', rtl: true } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
      };
    },

    /* هذا الأسبوع مقابل الماضي (نسبة الحضور لكل يوم) */
    weeklyCompare(filter = {}) {
      const cur = DB.weekRange();
      const prv = Analytics.prevRange(cur.from, cur.to);
      const rateByDay = range => Analytics.days(range.from, range.to, 7).map(d =>
        Analytics.sumStats(Analytics.reports({ from: d, to: d, ...filter })).rate);
      return {
        type: 'bar',
        data: { labels: DB.DAYS, datasets: [
          { label: 'الأسبوع الحالي', data: rateByDay(cur), backgroundColor: 'rgba(41,128,185,.75)', borderRadius: 5 },
          { label: 'الأسبوع الماضي', data: rateByDay(prv), backgroundColor: 'rgba(138,154,176,.45)', borderRadius: 5 },
        ]},
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', rtl: true } },
          scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } } },
      };
    },

    /* آخر n أشهر (نسبة الحضور الشهرية) */
    monthlyCompare(n = 6, filter = {}) {
      const t = new Date(), months = [];
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
        months.push({ key: DB.localISO(d).slice(0, 7), from: DB.localISO(d),
                      to: DB.localISO(new Date(d.getFullYear(), d.getMonth() + 1, 0)) });
      }
      const rates = months.map(m => Analytics.sumStats(Analytics.reports({ ...m, ...filter })).rate);
      const TH = Analytics.THRESHOLDS;
      return {
        type: 'bar',
        data: { labels: months.map(m => m.key), datasets: [{ label: 'نسبة الحضور %', data: rates,
          backgroundColor: rates.map(r => r === null ? '#8a9ab0' : r >= TH.green ? '#27ae60' : r >= TH.yellow ? '#e67e22' : '#e74c3c'),
          borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } } },
      };
    },

    /* مقارنة/ترتيب المستشفيات (من مصفوفة hospitals في overview) */
    hospitalRank(hospitals) {
      const sorted = [...hospitals].sort((a, b) => (b.stats.rate ?? -1) - (a.stats.rate ?? -1));
      return {
        type: 'bar',
        data: { labels: sorted.map(h => h.name), datasets: [{ label: 'نسبة الحضور %',
          data: sorted.map(h => h.stats.rate === null ? 0 : Math.round(h.stats.rate)),
          backgroundColor: sorted.map(h => (Analytics.HOSPITAL_META[h.name] || {}).color || '#2980b9'),
          borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } } },
      };
    },

    /* ترتيب الأقسام (أفضل topN من مصفوفة departments في overview) */
    deptRank(departments, topN = 10) {
      const TH = Analytics.THRESHOLDS;
      const ranked = departments.filter(d => d.stats.rate !== null)
        .sort((a, b) => b.stats.rate - a.stats.rate).slice(0, topN);
      return {
        type: 'bar',
        data: { labels: ranked.length ? ranked.map(d => d.department) : ['لا بيانات'],
          datasets: [{ label: 'نسبة الحضور %',
            data: ranked.length ? ranked.map(d => Math.round(d.stats.rate)) : [0],
            backgroundColor: ranked.length ? ranked.map(d =>
              d.stats.rate >= TH.green ? '#27ae60' : d.stats.rate >= TH.yellow ? '#e67e22' : '#e74c3c') : ['#8a9ab0'],
            borderRadius: 5 }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } } },
      };
    },

    /* عداد دائري لمؤشر واحد */
    gauge(value, color) {
      const v = value === null ? 0 : Math.round(value);
      return {
        type: 'doughnut',
        data: { labels: ['محقق', 'متبقٍ'],
          datasets: [{ data: [v, 100 - v], backgroundColor: [color, 'rgba(138,154,176,.18)'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '72%',
          plugins: { legend: { display: false }, tooltip: { enabled: false } } },
      };
    },
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
