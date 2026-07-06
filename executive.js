/* ============================================================
   مركز القيادة التنفيذي — الوحدة البرمجية (المرحلة 10)
   executive.js
   ------------------------------------------------------------
   لوحة قيادة لحظية للإدارة العليا. تعيد استخدام الطبقات القائمة
   دون تكرار كود:
     DB / Cloud / Sync (script.js)   — Supabase مصدر الحقيقة
     Analytics / AdminGate (analytics-core.js) — حسابات وبوابة مشتركة
     Theme / Toast / esc             — السمة والتنبيهات والتهريب

   الأداء: كل دورة عرض تبني «سياقاً» واحداً (ctx) يُحسب مرة واحدة
   ثم تتغذى منه كل اللوحات — لا تكرار للاستعلامات أو الحلقات.
   كل الأرقام من التقارير الفعلية — لا بيانات ثابتة.
   ============================================================ */

'use strict';

const ExecutiveApp = {

  range: { from: null, to: null },
  preset: 'today',
  _charts: {},
  _pollTimer: null,

  /* ======================================================
     1) بوابة الدخول — المكوّن المشترك AdminGate
     ====================================================== */
  _gateIds: { overlay: 'execLogin', input: 'execPassInput', error: 'execLoginError' },

  init()   { AdminGate.init(this._gateIds, () => this._showApp()); },
  login()  { AdminGate.login(this._gateIds, () => this._showApp()); },
  logout() { AdminGate.logout(); },

  async _showApp() {
    document.getElementById('execLogin').style.display = 'none';
    document.getElementById('execContent').style.display = 'flex';
    this.applyPreset('today', false);
    await this.refresh();
    if (!this._pollTimer)
      this._pollTimer = Analytics.autoRefresh('executive-reports', () => this.refresh());
  },

  async refresh(silent = true) {
    await Analytics.pull();     // Supabase أولاً
    this.renderAll();
    const stamp = document.getElementById('execLastRefresh');
    if (stamp) stamp.textContent = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
    if (!silent) Toast.show('تم تحديث البيانات', 'success', 2000);
  },

  /* ======================================================
     2) الفلاتر السريعة
     اليوم/أمس/أسبوع/شهر/ربع سنة/سنة/نطاق مخصص
     ====================================================== */
  applyPreset(preset, rerender = true) {
    this.preset = preset;
    if (preset !== 'custom') this.range = Analytics.rangeFor(preset);

    document.querySelectorAll('.map-filter-chip').forEach(c =>
      c.classList.toggle('active', c.dataset.preset === preset));
    document.getElementById('execCustomRange')?.classList.toggle('show', preset === 'custom');

    if (preset === 'custom') {
      const f = document.getElementById('execFromDate'), x = document.getElementById('execToDate');
      if (f && !f.value) f.value = this.range.from || DB.today();
      if (x && !x.value) x.value = this.range.to   || DB.today();
      this.range = { from: f?.value || DB.today(), to: x?.value || DB.today() };
    }

    const lbl = document.getElementById('execRangeLabel');
    if (lbl) lbl.textContent = this.range.from === this.range.to
      ? `التاريخ: ${this.range.from}`
      : `الفترة: ${this.range.from} ← ${this.range.to}`;

    if (rerender) this.renderAll();
  },

  applyCustomRange() {
    const f = document.getElementById('execFromDate')?.value;
    const t = document.getElementById('execToDate')?.value;
    if (!f || !t) return Toast.show('حدد تاريخ البداية والنهاية', 'warning');
    if (f > t)    return Toast.show('تاريخ البداية بعد تاريخ النهاية', 'warning');
    this.range = { from: f, to: t };
    this.applyPreset('custom');
  },

  /* ======================================================
     3) السياق (ctx) — النظرة الشاملة من الطبقة المشتركة
     (تُحسب مرة واحدة لكل دورة عرض وتغذي كل اللوحات)
     ====================================================== */
  _buildContext() { return Analytics.overview(this.range); },

  /* ======================================================
     4) العرض الكامل
     ====================================================== */
  renderAll() {
    const ctx = this._buildContext();
    this._ctx = ctx;                    // يُستخدم في التصدير
    this.renderSummary();
    this.renderKPIs(ctx);
    this.renderAlerts(ctx);
    this.renderCompare(ctx);
    this.renderTrendChart(ctx);
    this.renderWeeklyChart();
    this.renderMonthlyChart();
    this.renderDeptRanking(ctx);
    this.renderHospRanking(ctx);
    this.renderKpiProgress(ctx);
    this.renderHeatmap(ctx);
    this.renderTopPerformers(ctx);
    this.renderAttentionDepts(ctx);
    this.renderInsights(ctx);
  },

  /* ======================================================
     9-ب) أقسام تتطلب متابعة
     حضور أقل من 85% أو غياب فوق العتبة — الأسوأ أولاً
     ====================================================== */
  renderAttentionDepts(ctx) {
    const box = document.getElementById('execAttentionDepts');
    if (!box) return;
    const list = ctx.departments
      .filter(d => d.stats.rate !== null &&
        (d.stats.rate < Analytics.THRESHOLDS.yellow || d.stats.absenceRate > Analytics.ABSENCE_THRESHOLD))
      .sort((a, b) => a.stats.rate - b.stats.rate)
      .slice(0, 6);

    box.innerHTML = list.length
      ? list.map(d => {
          const st = Analytics.statusOf(d.stats.rate);
          return `
          <div class="exec-attention-row">
            <span class="hosp-status-badge ${st.cls}">${st.emoji} ${this._pct(d.stats.rate)}</span>
            <div class="exec-attention-info">
              <b>${esc(d.department)}</b>
              <span>${esc(d.hospital)} — غياب ${this._pct(d.stats.absenceRate)} · ${d.stats.count} تقرير</span>
            </div>
          </div>`;
        }).join('')
      : `<div class="exec-alert ok" style="margin:0"><i class="fas fa-circle-check"></i><span>لا توجد أقسام تتطلب متابعة في الفترة المحددة</span></div>`;
  },

  /* ---- مساعدات عرض صغيرة ---- */
  _pct(v)  { return v === null || isNaN(v) ? '—' : Math.round(v) + '%'; },
  _delta(cur, prv) {
    if (cur === null || prv === null) return '';
    const d = Math.round(cur - prv);
    if (!d) return `<span class="exec-kpi-trend" style="color:var(--text-muted)"><i class="fas fa-minus"></i></span>`;
    const up = d > 0;
    return `<span class="exec-kpi-trend" style="color:var(--${up ? 'success' : 'danger'})">
      <i class="fas fa-arrow-${up ? 'up' : 'down'}"></i> ${Math.abs(d)}</span>`;
  },

  /* ======================================================
     4-ب) الملخص التنفيذي — لقطة «اليوم» دائماً
     مستقل عن الفلتر المحدد: صانع القرار يرى حالة اليوم أولاً
     ====================================================== */
  renderSummary() {
    const bar = document.getElementById('execSummary');
    if (!bar) return;

    const today = DB.today();
    const reps = Analytics.reports({ from: today, to: today });
    const stats = Analytics.sumStats(reps);
    const comp = Analytics.compliance({ from: today, to: today });
    const status = Analytics.statusOf(stats.rate);

    // مستشفيات تحتاج انتباهاً اليوم: حضور <85% أو بلا أي تقرير
    const attention = DB.HOSPITALS.filter(h => {
      const s = Analytics.sumStats(reps.filter(r => r.hospital === h));
      return s.rate === null || s.rate < Analytics.THRESHOLDS.yellow;
    });

    const pending = DB.getReports().filter(r => r.status === 'pending').length;

    // التنبيهات الحرجة اليوم: مستشفى حرج + ارتفاع غياب (نفس منطق renderAlerts على نطاق اليوم)
    const yesterday = Analytics.prevRange(today, today);
    const yStats = Analytics.sumStats(Analytics.reports(yesterday));
    let critical = DB.HOSPITALS.filter(h => {
      const s = Analytics.sumStats(reps.filter(r => r.hospital === h));
      return s.rate !== null && s.rate < Analytics.THRESHOLDS.yellow;
    }).length;
    if (stats.absenceRate !== null && yStats.absenceRate !== null &&
        stats.absenceRate - yStats.absenceRate >= 3) critical++;

    const item = (icon, label, value, cls = '') => `
      <div class="exec-summary-item ${cls}">
        <i class="fas ${icon}"></i>
        <div><b>${value}</b><span>${label}</span></div>
      </div>`;

    bar.innerHTML =
      item('fa-flag', 'الحالة العامة', `${status.emoji} ${status.label}`) +
      item('fa-user-check', 'حضور اليوم', this._pct(stats.rate)) +
      item('fa-clipboard-check', 'التزام اليوم', this._pct(comp.rate)) +
      item('fa-hospital', 'مستشفيات تحتاج انتباهاً', attention.length, attention.length ? 'warn' : '') +
      item('fa-hourglass-half', 'تقارير معلقة', pending, pending ? 'warn' : '') +
      item('fa-triangle-exclamation', 'تنبيهات حرجة', critical, critical ? 'crit' : '');
  },

  /* ======================================================
     5) المؤشرات التنفيذية (KPIs)
     ====================================================== */
  renderKPIs(ctx) {
    const grid = document.getElementById('execKpiGrid');
    if (!grid) return;
    const s = ctx.stats, p = ctx.prevStats;
    const kpis = [
      { icon: 'fa-users',           color: '#2980b9', label: 'إجمالي الموظفين',     value: DB.getEmployees().length },
      { icon: 'fa-user-check',      color: '#27ae60', label: 'الحاضرون',            value: s.present,   trend: this._delta(s.present, p.present) },
      { icon: 'fa-user-xmark',      color: '#e74c3c', label: 'الغائبون',            value: s.absent,    trend: this._delta(p.absent, s.absent) },
      { icon: 'fa-umbrella-beach',  color: '#16a085', label: 'في إجازة',            value: s.leave },
      { icon: 'fa-person-walking-arrow-right', color: '#e67e22', label: 'المنسحبون', value: s.withdrawn },
      { icon: 'fa-percent',         color: '#8e44ad', label: 'نسبة الحضور',         value: this._pct(s.rate),      trend: this._delta(s.rate, p.rate) },
      { icon: 'fa-clipboard-check', color: '#1abc9c', label: 'نسبة الالتزام',       value: this._pct(ctx.comp.rate) },
      { icon: 'fa-file-circle-check', color: '#2c3e50', label: 'التقارير المرفوعة', value: s.count },
      { icon: 'fa-hourglass-half',  color: '#f39c12', label: 'بانتظار الاعتماد',    value: ctx.pendingAll },
    ];
    grid.innerHTML = kpis.map(k => `
      <div class="exec-kpi" style="--kpi-color:${k.color}">
        <div class="exec-kpi-icon"><i class="fas ${k.icon}"></i></div>
        <div><b>${k.value}${k.trend || ''}</b><span>${k.label}</span></div>
      </div>`).join('');
  },

  /* ======================================================
     6) التنبيهات الآلية
     ====================================================== */
  renderAlerts(ctx) {
    const box = document.getElementById('execAlerts');
    if (!box) return;
    const alerts = [];

    // مستشفى بنسبة حضور حرجة (<85%)
    ctx.hospitals.forEach(h => {
      if (h.stats.rate !== null && h.stats.rate < Analytics.THRESHOLDS.yellow)
        alerts.push({ cls: 'danger', icon: 'fa-triangle-exclamation',
          text: `${h.name}: نسبة الحضور ${Math.round(h.stats.rate)}% — أقل من الحد الحرج (85%)` });
    });

    // مستشفى لم يرفع تقرير اليوم
    ctx.hospitals.forEach(h => {
      if (h.todayReports === 0)
        alerts.push({ cls: 'warning', icon: 'fa-file-circle-xmark',
          text: `${h.name}: لم يُرفع أي تقرير دوام اليوم (${ctx.today})` });
    });

    // ارتفاع الغياب المتكرر مقارنة بالفترة السابقة
    if (ctx.stats.absenceRate !== null && ctx.prevStats.absenceRate !== null) {
      const d = ctx.stats.absenceRate - ctx.prevStats.absenceRate;
      if (d >= 3) alerts.push({ cls: 'danger', icon: 'fa-arrow-trend-up',
        text: `ارتفاع الغياب: نسبة الغياب زادت ${Math.round(d)} نقطة عن الفترة السابقة (${Math.round(ctx.prevStats.absenceRate)}% ← ${Math.round(ctx.stats.absenceRate)}%)` });
    }

    // أقسام تجاوزت عتبة الغياب
    const over = ctx.departments
      .filter(d => d.stats.absenceRate !== null && d.stats.absenceRate > Analytics.ABSENCE_THRESHOLD)
      .sort((a, b) => b.stats.absenceRate - a.stats.absenceRate);
    if (over.length) {
      const list = over.slice(0, 3).map(d => `${d.department} (${Math.round(d.stats.absenceRate)}%)`).join('، ');
      alerts.push({ cls: 'warning', icon: 'fa-building-circle-exclamation',
        text: `${over.length} قسم تجاوز عتبة الغياب (${Analytics.ABSENCE_THRESHOLD}%): ${list}${over.length > 3 ? '…' : ''}` });
    }

    box.innerHTML = alerts.length
      ? alerts.map(a => `<div class="exec-alert ${a.cls}"><i class="fas ${a.icon}"></i><span>${esc(a.text)}</span></div>`).join('')
      : `<div class="exec-alert ok"><i class="fas fa-circle-check"></i><span>لا توجد تنبيهات — كل المؤشرات ضمن الحدود الطبيعية</span></div>`;
  },

  /* ======================================================
     7) جدول مقارنة المستشفيات
     ====================================================== */
  renderCompare(ctx) {
    const body = document.getElementById('execCompareBody');
    if (!body) return;
    body.innerHTML = ctx.hospitals.map(h => {
      const st = Analytics.statusOf(h.stats.rate);
      const bar = (v, color) => v === null ? '' :
        `<div class="exec-mini-bar"><div style="width:${Math.min(100, Math.round(v))}%;background:${color}"></div></div>`;
      return `
      <tr>
        <td><strong>${esc(h.name)}</strong></td>
        <td>${this._pct(h.stats.rate)}${bar(h.stats.rate, 'var(--secondary)')}</td>
        <td>${this._pct(h.comp.rate)}${bar(h.comp.rate, 'var(--accent)')}</td>
        <td>${h.comp.missing === null ? '<span class="badge badge-primary">لا جداول</span>' : h.comp.missing}</td>
        <td>${h.employees}</td>
        <td>${st.emoji} ${st.label}</td>
      </tr>`;
    }).join('');
  },

  /* ======================================================
     8) الرسوم البيانية (Chart.js عبر المساعد المشترك)
     ====================================================== */
  _chart(id, config) { Analytics.chart(this._charts, id, config); },

  /* ---- الرسوم: إعداداتها من مصانع الطبقة المشتركة ---- */
  renderTrendChart(ctx) { this._chart('execChartTrend',    Analytics.chartCfg.trend(ctx.reps, ctx.from, ctx.to)); },
  renderWeeklyChart()   { this._chart('execChartWeekly',   Analytics.chartCfg.weeklyCompare()); },
  renderMonthlyChart()  { this._chart('execChartMonthly',  Analytics.chartCfg.monthlyCompare(6)); },
  renderDeptRanking(ctx){ this._chart('execChartDeptRank', Analytics.chartCfg.deptRank(ctx.departments, 10)); },
  renderHospRanking(ctx){ this._chart('execChartHospRank', Analytics.chartCfg.hospitalRank(ctx.hospitals)); },

  /* ---- تقدم مؤشرات الأداء (عدادات دائرية) ---- */
  renderKpiProgress(ctx) {
    const approved = ctx.reps.filter(r => r.status === 'approved').length;
    const approval = ctx.reps.length ? (approved / ctx.reps.length) * 100 : null;
    const gauges = [
      { id: 'execGaugeAttendance', label: 'execGaugeAttendanceVal', value: ctx.stats.rate,  color: '#2980b9' },
      { id: 'execGaugeCompliance', label: 'execGaugeComplianceVal', value: ctx.comp.rate,   color: '#1abc9c' },
      { id: 'execGaugeApproval',   label: 'execGaugeApprovalVal',   value: approval,        color: '#8e44ad' },
    ];
    gauges.forEach(g => {
      const el = document.getElementById(g.label);
      if (el) { el.textContent = this._pct(g.value); el.style.color = g.color; }
      this._chart(g.id, Analytics.chartCfg.gauge(g.value, g.color));
    });
  },

  /* ---- الخريطة الحرارية: المستشفيات × الأيام (آخر ≤31 يوماً من النطاق) ---- */
  renderHeatmap(ctx) {
    const wrap = document.getElementById('execHeatmap');
    if (!wrap) return;
    const days = Analytics.days(ctx.from, ctx.to).slice(-31);
    const cls = r => r === null ? 'hm-empty'
      : r >= Analytics.THRESHOLDS.green ? 'hm-green'
      : r >= Analytics.THRESHOLDS.yellow ? 'hm-yellow' : 'hm-red';

    wrap.innerHTML = `
      <table class="exec-heatmap">
        <tr><th></th>${days.map(d => `<th>${d.slice(8)}<br>${d.slice(5, 7)}</th>`).join('')}</tr>
        ${DB.HOSPITALS.map(h => {
          const hReps = ctx.reps.filter(r => r.hospital === h);
          return `<tr>
            <td class="hm-label">${esc(h)}</td>
            ${days.map(d => {
              const s = Analytics.sumStats(hReps.filter(r => r.date === d));
              return `<td class="hm-cell ${cls(s.rate)}" title="${esc(h)} — ${d}: ${this._pct(s.rate)}"></td>`;
            }).join('')}
          </tr>`;
        }).join('')}
      </table>`;
  },

  /* ======================================================
     9) الأفضل أداءً
     ====================================================== */
  renderTopPerformers(ctx) {
    const grid = document.getElementById('execTopGrid');
    if (!grid) return;

    const withData = ctx.hospitals.filter(h => h.stats.rate !== null);
    const topHosp = withData.length ? withData.reduce((a, b) => a.stats.rate >= b.stats.rate ? a : b) : null;

    const deptsWithData = ctx.departments.filter(d => d.stats.rate !== null);
    const topDept = deptsWithData.length ? deptsWithData.reduce((a, b) => a.stats.rate >= b.stats.rate ? a : b) : null;

    const improvable = ctx.departments.filter(d => d.stats.rate !== null && d.prevStats.rate !== null);
    const improved = improvable.length
      ? improvable.reduce((a, b) => (a.stats.rate - a.prevStats.rate) >= (b.stats.rate - b.prevStats.rate) ? a : b)
      : null;
    const impDelta = improved ? Math.round(improved.stats.rate - improved.prevStats.rate) : 0;

    const card = (icon, label, value, sub) => `
      <div class="exec-top-card">
        <div class="exec-top-icon"><i class="fas ${icon}"></i></div>
        <div class="exec-top-label">${label}</div>
        <div class="exec-top-value">${value}</div>
        <div class="exec-top-sub">${sub}</div>
      </div>`;

    grid.innerHTML = [
      card('fa-trophy', 'أفضل مستشفى',
        topHosp ? esc(topHosp.name) : '—',
        topHosp ? `حضور ${this._pct(topHosp.stats.rate)}` : 'لا بيانات في الفترة'),
      card('fa-medal', 'أفضل قسم',
        topDept ? esc(topDept.department) : '—',
        topDept ? `${esc(topDept.hospital)} — ${this._pct(topDept.stats.rate)}` : 'لا بيانات في الفترة'),
      card('fa-percent', 'أعلى نسبة حضور',
        topDept ? this._pct(topDept.stats.rate) : this._pct(ctx.stats.rate),
        topDept ? esc(topDept.department) : 'إجمالي الفترة'),
      card('fa-arrow-trend-up', 'الأكثر تحسناً',
        improved && impDelta > 0 ? esc(improved.department) : '—',
        improved && impDelta > 0 ? `+${impDelta} نقطة عن الفترة السابقة` : 'لا تحسن ملحوظ'),
    ].join('');
  },

  /* ======================================================
     10) الرؤى الذكية — جُمل إدارية مولّدة آلياً من الأرقام
     ====================================================== */
  renderInsights(ctx) {
    const box = document.getElementById('execInsights');
    if (!box) return;
    // توليد الرؤى في الطبقة المشتركة — العرض فقط هنا
    const out = Analytics.observations(ctx, this.preset === 'today' ? 'أمس' : 'الفترة السابقة');

    box.innerHTML = out.length
      ? out.map(i => `<div class="exec-insight ${i.cls}"><i class="fas ${i.icon}"></i><span>${esc(i.text)}</span></div>`).join('')
      : `<div class="exec-insight"><i class="fas fa-circle-info"></i><span>لا توجد بيانات كافية في الفترة المحددة لتوليد رؤى.</span></div>`;
  },

  /* ======================================================
     11) التصدير: Excel / طباعة / PDF
     ====================================================== */
  exportExcel() {
    const ctx = this._ctx || this._buildContext();
    if (typeof XLSX === 'undefined') return Toast.show('تعذر تحميل مكتبة التصدير', 'error');
    if (!ctx.reps.length) return Toast.show('لا توجد بيانات للتصدير في هذه الفترة', 'warning');

    const wb = XLSX.utils.book_new();

    const kpiRows = [
      { 'المؤشر': 'إجمالي الموظفين',   'القيمة': DB.getEmployees().length },
      { 'المؤشر': 'الحاضرون',          'القيمة': ctx.stats.present },
      { 'المؤشر': 'الغائبون',          'القيمة': ctx.stats.absent },
      { 'المؤشر': 'في إجازة',          'القيمة': ctx.stats.leave },
      { 'المؤشر': 'المنسحبون',         'القيمة': ctx.stats.withdrawn },
      { 'المؤشر': 'نسبة الحضور %',     'القيمة': ctx.stats.rate === null ? '-' : Math.round(ctx.stats.rate) },
      { 'المؤشر': 'نسبة الالتزام %',   'القيمة': ctx.comp.rate === null ? '-' : Math.round(ctx.comp.rate) },
      { 'المؤشر': 'التقارير المرفوعة', 'القيمة': ctx.stats.count },
      { 'المؤشر': 'بانتظار الاعتماد',  'القيمة': ctx.pendingAll },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiRows), 'المؤشرات');

    const cmpRows = ctx.hospitals.map(h => ({
      'المستشفى': h.name,
      'نسبة الحضور %': h.stats.rate === null ? '-' : Math.round(h.stats.rate),
      'نسبة الالتزام %': h.comp.rate === null ? '-' : Math.round(h.comp.rate),
      'تقارير ناقصة': h.comp.missing === null ? '-' : h.comp.missing,
      'عدد الموظفين': h.employees,
      'حاضر': h.stats.present, 'غائب': h.stats.absent,
      'إجازة': h.stats.leave, 'منسحب': h.stats.withdrawn,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cmpRows), 'مقارنة المستشفيات');

    const deptRows = ctx.departments
      .sort((a, b) => (b.stats.rate ?? -1) - (a.stats.rate ?? -1))
      .map(d => ({
        'القسم': d.department, 'المستشفى': d.hospital,
        'نسبة الحضور %': d.stats.rate === null ? '-' : Math.round(d.stats.rate),
        'حاضر': d.stats.present, 'غائب': d.stats.absent,
        'إجازة': d.stats.leave, 'منسحب': d.stats.withdrawn,
        'عدد التقارير': d.stats.count,
      }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deptRows), 'ترتيب الأقسام');

    XLSX.writeFile(wb, `مركز_القيادة_${ctx.from}_${ctx.to}.xlsx`);
    Toast.show('تم تصدير ملف Excel بنجاح', 'success');
    DB.audit('تصدير Excel', `مركز القيادة — ${ctx.from} إلى ${ctx.to}`);
  },

  /* الطباعة وPDF عبر نافذة الطباعة (نهج المنصة القائم — «حفظ كـ PDF») */
  printPage() {
    const h = document.getElementById('execPrintRange');
    if (h) h.textContent = `الفترة: ${this.range.from} ← ${this.range.to} — طُبع في ${new Date().toLocaleString('ar-SA')}`;
    window.print();
    DB.audit('طباعة', 'مركز القيادة التنفيذي');
  },

  exportPDF() {
    Toast.show('في نافذة الطباعة اختر «حفظ كـ PDF» كوجهة', 'info', 4000);
    this.printPage();
  },
};

/* ======================================================
   تهيئة الصفحة — لا تعمل إلا في صفحة مركز القيادة
   ====================================================== */
document.addEventListener('DOMContentLoaded', () => {
  if (document.body.dataset.page === 'executive') ExecutiveApp.init();
});
