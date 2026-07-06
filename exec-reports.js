/* ============================================================
   نظام التقارير التنفيذية — الوحدة البرمجية (المرحلة 15)
   exec-reports.js
   ------------------------------------------------------------
   إنشاء تقارير احترافية (يومي/أسبوعي/شهري/ربع سنوي/سنوي/مخصص)
   مع معاينة قبل التصدير، وطباعة/PDF وExcel.

   لا تكرار كود — كل الحسابات من الطبقة المشتركة:
     Analytics.overview / observations / chartCfg / compliance
     AdminGate (البوابة) · DB/Cloud/Sync (Supabase مصدر الحقيقة)
   ============================================================ */

'use strict';

const ExecReports = {

  _charts: {},
  _ov: null,          // آخر نظرة شاملة مولّدة (للتصدير)
  _meta: null,        // عنوان/فترة آخر تقرير

  /* ======================================================
     1) البوابة والتهيئة
     ====================================================== */
  _gateIds: { overlay: 'rptLogin', input: 'rptPassInput', error: 'rptLoginError' },

  init()   { AdminGate.init(this._gateIds, () => this._showApp()); },
  login()  { AdminGate.login(this._gateIds, () => this._showApp()); },
  logout() { AdminGate.logout(); },

  async _showApp() {
    document.getElementById('rptLogin').style.display = 'none';
    document.getElementById('rptContent').style.display = 'flex';

    await Analytics.pull();                 // أحدث البيانات من Supabase
    this._populateFilters();
    this._onTypeChange();                   // ضبط حقول التاريخ الافتراضية

    // تحديث القوائم عند وصول بيانات جديدة (دون إعادة توليد تقرير مفتوح)
    Analytics.autoRefresh('exec-reports', async () => {
      await Analytics.pull();
      this._populateFilters(true);
    });
  },

  /* ======================================================
     2) المُنشئ: تعبئة الفلاتر وحقول التاريخ
     ====================================================== */
  _populateFilters(keepSelection = false) {
    const hSel = document.getElementById('rptHospital');
    const dSel = document.getElementById('rptDept');
    const eSel = document.getElementById('rptEmployee');
    if (!hSel || !dSel || !eSel) return;
    const keep = el => keepSelection ? el.value : '';

    const hv = keep(hSel);
    hSel.innerHTML = `<option value="">كل المستشفيات</option>` +
      DB.HOSPITALS.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
    hSel.value = hv;

    this._populateDepts(keepSelection);

    const ev = keep(eSel);
    eSel.innerHTML = `<option value="">كل الموظفين</option>` +
      DB.getEmployees().map(e => `<option value="${esc(e.code)}">${esc(e.name)} (${esc(e.code)})</option>`).join('');
    eSel.value = ev;
  },

  /* الأقسام تتبع المستشفى المختار */
  _populateDepts(keepSelection = false) {
    const dSel = document.getElementById('rptDept');
    const h = document.getElementById('rptHospital')?.value || '';
    if (!dSel) return;
    const dv = keepSelection ? dSel.value : '';
    let depts = DB.getDepartments();
    if (h) depts = depts.filter(d => d.hospital === h);
    dSel.innerHTML = `<option value="">كل الأقسام</option>` +
      [...new Set(depts.map(d => d.name))].map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    dSel.value = dv;
  },

  /* نوع التقرير يحدد حقل التاريخ الظاهر */
  _onTypeChange() {
    const type = document.getElementById('rptType')?.value || 'daily';
    const show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
    const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

    ['rptDateField', 'rptMonthField', 'rptYearField', 'rptFromField', 'rptToField'].forEach(hide);

    if (type === 'daily' || type === 'weekly' || type === 'quarterly') {
      show('rptDateField');
      const d = document.getElementById('rptDate');
      if (d && !d.value) d.value = DB.today();
    } else if (type === 'monthly') {
      show('rptMonthField');
      const m = document.getElementById('rptMonth');
      if (m && !m.value) m.value = DB.thisMonth();
    } else if (type === 'annual') {
      show('rptYearField');
      const y = document.getElementById('rptYear');
      if (y && !y.value) y.value = String(new Date().getFullYear());
    } else { // custom
      show('rptFromField'); show('rptToField');
      const f = document.getElementById('rptFrom'), t = document.getElementById('rptTo');
      if (f && !f.value) f.value = DB.today();
      if (t && !t.value) t.value = DB.today();
    }
  },

  /* حساب نطاق التقرير من نوعه ومدخلاته */
  _resolveRange() {
    const type = document.getElementById('rptType')?.value || 'daily';
    const iso = d => DB.localISO(d);

    if (type === 'daily') {
      const d = document.getElementById('rptDate')?.value || DB.today();
      return { type, label: 'تقرير يومي', from: d, to: d };
    }
    if (type === 'weekly') {
      // الأسبوع (أحد–سبت) الذي يحوي التاريخ المحدد
      const base = new Date((document.getElementById('rptDate')?.value || DB.today()) + 'T00:00:00');
      const sun = new Date(base); sun.setDate(base.getDate() - base.getDay());
      const sat = new Date(sun);  sat.setDate(sun.getDate() + 6);
      return { type, label: 'تقرير أسبوعي', from: iso(sun), to: iso(sat) };
    }
    if (type === 'monthly') {
      const m = document.getElementById('rptMonth')?.value || DB.thisMonth();
      const [y, mo] = m.split('-').map(Number);
      return { type, label: 'تقرير شهري', from: `${m}-01`, to: iso(new Date(y, mo, 0)) };
    }
    if (type === 'quarterly') {
      const base = new Date((document.getElementById('rptDate')?.value || DB.today()) + 'T00:00:00');
      const q = Math.floor(base.getMonth() / 3);
      return { type, label: `تقرير ربع سنوي (الربع ${q + 1})`,
        from: iso(new Date(base.getFullYear(), q * 3, 1)),
        to:   iso(new Date(base.getFullYear(), q * 3 + 3, 0)) };
    }
    if (type === 'annual') {
      const y = parseInt(document.getElementById('rptYear')?.value, 10) || new Date().getFullYear();
      return { type, label: `تقرير سنوي ${y}`, from: `${y}-01-01`, to: `${y}-12-31` };
    }
    // custom
    const f = document.getElementById('rptFrom')?.value || DB.today();
    const t = document.getElementById('rptTo')?.value || DB.today();
    return { type, label: 'تقرير لفترة مخصصة', from: f, to: t };
  },

  /* ======================================================
     3) توليد التقرير (معاينة فورية)
     ====================================================== */
  async generate() {
    const range = this._resolveRange();
    if (range.from > range.to) return Toast.show('تاريخ البداية بعد تاريخ النهاية', 'warning');

    await Analytics.pull();   // أحدث نسخة من Supabase قبل التوليد

    const filters = {
      hospital:   document.getElementById('rptHospital')?.value || null,
      department: document.getElementById('rptDept')?.value || null,
      employee:   document.getElementById('rptEmployee')?.value || null,
      status:     document.getElementById('rptStatus')?.value || null,
    };
    const ov = Analytics.overview({ from: range.from, to: range.to, ...filters });
    this._ov = ov;
    this._meta = { ...range, filters, generatedAt: new Date() };

    this._renderDoc(ov);
    const wrap = document.getElementById('rptPreviewWrap');
    wrap?.classList.add('show');
    wrap?.scrollIntoView?.({ behavior: 'smooth' });
    DB.audit('توليد تقرير تنفيذي', `${range.label}: ${range.from} ← ${range.to}`);
  },

  /* ---- مساعدات عرض ---- */
  _pct(v) { return v === null || isNaN(v) ? '—' : Math.round(v) + '%'; },

  _filterSummary() {
    const f = this._meta.filters;
    const parts = [];
    if (f.hospital)   parts.push(`المستشفى: ${f.hospital}`);
    if (f.department) parts.push(`القسم: ${f.department}`);
    if (f.employee) {
      const emp = DB.getEmployees().find(e => e.code.toUpperCase() === f.employee.toUpperCase());
      parts.push(`الموظف: ${emp ? emp.name : f.employee}`);
    }
    if (f.status) parts.push(`الحالة: ${f.status === 'approved' ? 'معتمدة فقط' : 'معلقة فقط'}`);
    return parts.length ? parts.join(' · ') : 'كل المستشفيات والأقسام';
  },

  /* ======================================================
     4) بناء مستند التقرير
     ====================================================== */
  _renderDoc(ov) {
    const doc = document.getElementById('rptDoc');
    if (!doc) return;
    const m = this._meta;
    const incLeave = document.getElementById('rptIncLeave')?.checked !== false;
    const incWithdrawn = document.getElementById('rptIncWithdrawn')?.checked !== false;

    const approved = ov.reps.filter(r => r.status === 'approved').length;
    const status = Analytics.statusOf(ov.stats.rate);

    /* الملخص التنفيذي */
    const attentionDepts = ov.departments.filter(d => d.stats.rate !== null &&
      (d.stats.rate < Analytics.THRESHOLDS.yellow || d.stats.absenceRate > Analytics.ABSENCE_THRESHOLD));
    const attentionHosps = ov.hospitals.filter(h => h.stats.rate !== null && h.stats.rate < Analytics.THRESHOLDS.yellow);
    const withData = ov.hospitals.filter(h => h.stats.rate !== null);
    const bestHosp = withData.length ? withData.reduce((a, b) => a.stats.rate >= b.stats.rate ? a : b) : null;
    const deptsWithData = ov.departments.filter(d => d.stats.rate !== null);
    const bestDept = deptsWithData.length ? deptsWithData.reduce((a, b) => a.stats.rate >= b.stats.rate ? a : b) : null;
    const criticalAlerts = attentionHosps.length +
      ((ov.stats.absenceRate !== null && ov.prevStats.absenceRate !== null &&
        ov.stats.absenceRate - ov.prevStats.absenceRate >= 3) ? 1 : 0);

    const sItem = (label, val) => `<div class="rpt-summary-item"><b>${val}</b><span>${label}</span></div>`;

    /* جدول المستشفيات */
    const hospRows = ov.hospitals.map(h => {
      const st = Analytics.statusOf(h.stats.rate);
      return `<tr>
        <td><strong>${esc(h.name)}</strong></td>
        <td>${this._pct(h.stats.rate)}</td>
        <td>${h.stats.present}</td><td>${h.stats.absent}</td>
        ${incLeave ? `<td>${h.stats.leave}</td>` : ''}
        ${incWithdrawn ? `<td>${h.stats.withdrawn}</td>` : ''}
        <td>${this._pct(h.comp.rate)}</td>
        <td>${st.emoji} ${st.label}</td>
      </tr>`;
    }).join('');

    /* جدول ترتيب الأقسام */
    const deptRows = [...ov.departments]
      .sort((a, b) => (b.stats.rate ?? -1) - (a.stats.rate ?? -1))
      .map((d, i) => {
        const st = Analytics.statusOf(d.stats.rate);
        return `<tr>
          <td>${i + 1}</td>
          <td><strong>${esc(d.department)}</strong></td>
          <td>${esc(d.hospital)}</td>
          <td>${this._pct(d.stats.rate)}</td>
          <td>${d.stats.present}</td><td>${d.stats.absent}</td>
          ${incLeave ? `<td>${d.stats.leave}</td>` : ''}
          ${incWithdrawn ? `<td>${d.stats.withdrawn}</td>` : ''}
          <td>${st.emoji}</td>
        </tr>`;
      }).join('') ||
      `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:14px">لا توجد بيانات أقسام في الفترة</td></tr>`;

    /* ملخص الأداء النصي */
    const perfText = ov.stats.denom
      ? `خلال الفترة من ${m.from} إلى ${m.to} بلغت نسبة الحضور الإجمالية ${this._pct(ov.stats.rate)} ` +
        `(${ov.stats.present} حاضراً من أصل ${ov.stats.denom} مرصوداً)، ونسبة الالتزام برفع التقارير ${this._pct(ov.comp.rate)}. ` +
        `اعتُمد ${approved} تقريراً من ${ov.stats.count} مرفوعاً${ov.pendingAll ? `، ويبقى ${ov.pendingAll} بانتظار الاعتماد` : ''}. ` +
        `الحالة العامة: ${status.emoji} ${status.label}.`
      : 'لا توجد بيانات دوام مرصودة في الفترة المحددة وفق الفلاتر المختارة.';

    /* الملاحظات الآلية */
    const obs = Analytics.observations(ov, m.type === 'daily' ? 'اليوم السابق' : 'الفترة السابقة');

    doc.innerHTML = `
      <!-- ترويسة رسمية -->
      <div class="rpt-doc-header">
        <div class="rpt-logo"><i class="fas fa-hospital-user"></i></div>
        <div class="rpt-head-text">
          <h1>${esc(m.label)} — ${esc(m.from === m.to ? m.from : m.from + ' ← ' + m.to)}</h1>
          <div class="rpt-platform">منصة مراقبة الدوام · مدينة الملك سلمان الطبية</div>
          <div class="rpt-platform" style="font-weight:400">${esc(this._filterSummary())}</div>
        </div>
        <div class="rpt-meta">
          تاريخ الإصدار: ${m.generatedAt.toLocaleDateString('ar-SA')}<br>
          وقت الإصدار: ${m.generatedAt.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}<br>
          أُنشئ آلياً من بيانات المنصة
        </div>
      </div>

      <!-- الملخص التنفيذي -->
      <div class="rpt-section-h"><i class="fas fa-star"></i> الملخص التنفيذي</div>
      <div class="rpt-summary-grid">
        ${sItem('الأداء العام', `${status.emoji} ${status.label}`)}
        ${sItem('نسبة الحضور', this._pct(ov.stats.rate))}
        ${sItem('نسبة الالتزام', this._pct(ov.comp.rate))}
        ${sItem('أفضل مستشفى', bestHosp ? esc(bestHosp.name) : '—')}
        ${sItem('أفضل قسم', bestDept ? esc(bestDept.department) : '—')}
        ${sItem('أقسام تتطلب متابعة', attentionDepts.length)}
        ${sItem('مستشفيات تتطلب متابعة', attentionHosps.length)}
        ${sItem('تنبيهات حرجة', criticalAlerts)}
      </div>

      <!-- المؤشرات التفصيلية -->
      <div class="rpt-section-h"><i class="fas fa-gauge-high"></i> مؤشرات الفترة</div>
      <div class="rpt-summary-grid">
        ${sItem('الحاضرون', ov.stats.present)}
        ${sItem('الغائبون', ov.stats.absent)}
        ${incLeave ? sItem('في إجازة', ov.stats.leave) : ''}
        ${incWithdrawn ? sItem('المنسحبون', ov.stats.withdrawn) : ''}
        ${sItem('تقارير مكتملة (معتمدة)', approved)}
        ${sItem('تقارير معلقة', ov.pendingAll)}
        ${sItem('إجمالي التقارير', ov.stats.count)}
        ${sItem('خانات ناقصة', ov.comp.missing === null ? '—' : ov.comp.missing)}
      </div>

      <!-- الرسوم البيانية -->
      <div class="rpt-section-h"><i class="fas fa-chart-line"></i> التحليل البصري</div>
      <div class="rpt-charts-grid">
        <div class="rpt-chart-box"><div class="t">اتجاه الحضور والغياب</div><div class="rpt-chart-canvas"><canvas id="rptChartTrend"></canvas></div></div>
        <div class="rpt-chart-box"><div class="t">مقارنة أسبوعية (الحالي مقابل الماضي)</div><div class="rpt-chart-canvas"><canvas id="rptChartWeekly"></canvas></div></div>
        <div class="rpt-chart-box"><div class="t">مقارنة شهرية (آخر 6 أشهر)</div><div class="rpt-chart-canvas"><canvas id="rptChartMonthly"></canvas></div></div>
        <div class="rpt-chart-box"><div class="t">مقارنة المستشفيات</div><div class="rpt-chart-canvas"><canvas id="rptChartHosp"></canvas></div></div>
        <div class="rpt-chart-box"><div class="t">مقارنة الأقسام (أفضل 10)</div><div class="rpt-chart-canvas"><canvas id="rptChartDept"></canvas></div></div>
        <div class="rpt-chart-box"><div class="t">ملخص مؤشرات الأداء</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
            <div><div style="position:relative;height:110px"><canvas id="rptGauge1"></canvas></div><b id="rptGauge1Val">—</b><div style="font-size:11px;color:var(--text-muted)">الحضور</div></div>
            <div><div style="position:relative;height:110px"><canvas id="rptGauge2"></canvas></div><b id="rptGauge2Val">—</b><div style="font-size:11px;color:var(--text-muted)">الالتزام</div></div>
            <div><div style="position:relative;height:110px"><canvas id="rptGauge3"></canvas></div><b id="rptGauge3Val">—</b><div style="font-size:11px;color:var(--text-muted)">الاعتماد</div></div>
          </div>
        </div>
      </div>

      <!-- ترتيب المستشفيات -->
      <div class="rpt-section-h"><i class="fas fa-hospital"></i> ترتيب المستشفيات</div>
      <div class="hosp-table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>المستشفى</th><th>الحضور</th><th>حاضر</th><th>غائب</th>
            ${incLeave ? '<th>إجازة</th>' : ''}${incWithdrawn ? '<th>منسحب</th>' : ''}
            <th>الالتزام</th><th>الحالة</th>
          </tr></thead>
          <tbody>${hospRows}</tbody>
        </table>
      </div>

      <!-- ترتيب الأقسام -->
      <div class="rpt-section-h"><i class="fas fa-sitemap"></i> ترتيب الأقسام</div>
      <div class="hosp-table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>#</th><th>القسم</th><th>المستشفى</th><th>الحضور</th><th>حاضر</th><th>غائب</th>
            ${incLeave ? '<th>إجازة</th>' : ''}${incWithdrawn ? '<th>منسحب</th>' : ''}
            <th>الحالة</th>
          </tr></thead>
          <tbody>${deptRows}</tbody>
        </table>
      </div>

      <!-- ملخص الأداء والملاحظات -->
      <div class="rpt-section-h"><i class="fas fa-file-lines"></i> ملخص الأداء</div>
      <p style="font-size:13.5px;color:var(--text);line-height:2">${esc(perfText)}</p>

      <div class="rpt-section-h"><i class="fas fa-lightbulb"></i> ملاحظات مولّدة آلياً</div>
      <div class="rpt-observations">
        ${obs.length
          ? obs.map(o => `<div class="rpt-obs ${o.cls}"><i class="fas ${o.icon}"></i><span>${esc(o.text)}</span></div>`).join('')
          : '<div class="rpt-obs"><i class="fas fa-circle-info"></i><span>لا توجد بيانات كافية لتوليد ملاحظات.</span></div>'}
      </div>

      <!-- تذييل المستند -->
      <div class="rpt-doc-footer">
        <span>منصة مراقبة الدوام — مدينة الملك سلمان الطبية</span>
        <span>وثيقة داخلية · أُنشئت آلياً في ${m.generatedAt.toLocaleString('ar-SA')}</span>
      </div>`;

    /* الرسوم — مصانع الإعدادات المشتركة (بنفس فلاتر التقرير) */
    const f = { hospital: m.filters.hospital, department: m.filters.department,
                employee: m.filters.employee, status: m.filters.status };
    Analytics.chart(this._charts, 'rptChartTrend',   Analytics.chartCfg.trend(ov.reps, ov.from, ov.to));
    Analytics.chart(this._charts, 'rptChartWeekly',  Analytics.chartCfg.weeklyCompare(f));
    Analytics.chart(this._charts, 'rptChartMonthly', Analytics.chartCfg.monthlyCompare(6, f));
    Analytics.chart(this._charts, 'rptChartHosp',    Analytics.chartCfg.hospitalRank(ov.hospitals));
    Analytics.chart(this._charts, 'rptChartDept',    Analytics.chartCfg.deptRank(ov.departments, 10));

    const approval = ov.reps.length ? (approved / ov.reps.length) * 100 : null;
    [['rptGauge1', ov.stats.rate, '#2980b9'], ['rptGauge2', ov.comp.rate, '#1abc9c'], ['rptGauge3', approval, '#8e44ad']]
      .forEach(([id, val, color]) => {
        Analytics.chart(this._charts, id, Analytics.chartCfg.gauge(val, color));
        const el = document.getElementById(id + 'Val');
        if (el) { el.textContent = this._pct(val); el.style.color = color; }
      });
  },

  /* ======================================================
     5) التصدير: طباعة / PDF / Excel
     ====================================================== */
  _ensureGenerated() {
    if (!this._ov) { Toast.show('أنشئ التقرير أولاً بزر «توليد التقرير»', 'warning'); return false; }
    return true;
  },

  printReport() {
    if (!this._ensureGenerated()) return;
    const ft = document.getElementById('rptPrintFooterText');
    if (ft) ft.textContent =
      `${this._meta.label} · ${this._meta.from} ← ${this._meta.to} · طُبع في ${new Date().toLocaleString('ar-SA')}`;
    window.print();
    DB.audit('طباعة تقرير تنفيذي', this._meta.label);
  },

  exportPDF() {
    if (!this._ensureGenerated()) return;
    Toast.show('في نافذة الطباعة اختر «حفظ كـ PDF» — ولإظهار أرقام الصفحات فعّل «الترويسات والتذييلات»', 'info', 5000);
    this.printReport();
  },

  exportExcel() {
    if (!this._ensureGenerated()) return;
    if (typeof XLSX === 'undefined') return Toast.show('تعذر تحميل مكتبة التصدير', 'error');
    const ov = this._ov, m = this._meta;
    const approved = ov.reps.filter(r => r.status === 'approved').length;
    const wb = XLSX.utils.book_new();

    /* ورقة الغلاف والملخص — بترويسة احترافية */
    const cover = [
      ['منصة مراقبة الدوام — مدينة الملك سلمان الطبية'],
      [m.label],
      [`الفترة: ${m.from} ← ${m.to}`],
      [`الفلاتر: ${this._filterSummary()}`],
      [`تاريخ الإصدار: ${m.generatedAt.toLocaleString('ar-SA')}`],
      [],
      ['المؤشر', 'القيمة'],
      ['نسبة الحضور %', ov.stats.rate === null ? '-' : Math.round(ov.stats.rate)],
      ['نسبة الالتزام %', ov.comp.rate === null ? '-' : Math.round(ov.comp.rate)],
      ['الحاضرون', ov.stats.present],
      ['الغائبون', ov.stats.absent],
      ['في إجازة', ov.stats.leave],
      ['المنسحبون', ov.stats.withdrawn],
      ['تقارير مكتملة (معتمدة)', approved],
      ['تقارير معلقة', ov.pendingAll],
      ['إجمالي التقارير', ov.stats.count],
      ['خانات ناقصة', ov.comp.missing === null ? '-' : ov.comp.missing],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(cover);
    ws1['!cols'] = [{ wch: 34 }, { wch: 22 }];
    ws1['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 1 } },
      { s: { r: 3, c: 0 }, e: { r: 3, c: 1 } },
      { s: { r: 4, c: 0 }, e: { r: 4, c: 1 } },
    ];
    XLSX.utils.book_append_sheet(wb, ws1, 'الملخص التنفيذي');

    /* ورقة المستشفيات */
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ov.hospitals.map(h => ({
      'المستشفى': h.name,
      'نسبة الحضور %': h.stats.rate === null ? '-' : Math.round(h.stats.rate),
      'نسبة الالتزام %': h.comp.rate === null ? '-' : Math.round(h.comp.rate),
      'حاضر': h.stats.present, 'غائب': h.stats.absent,
      'إجازة': h.stats.leave, 'منسحب': h.stats.withdrawn,
      'تقارير ناقصة': h.comp.missing === null ? '-' : h.comp.missing,
      'عدد الموظفين': h.employees,
    }))), 'المستشفيات');

    /* ورقة الأقسام */
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
      [...ov.departments].sort((a, b) => (b.stats.rate ?? -1) - (a.stats.rate ?? -1)).map((d, i) => ({
        'الترتيب': i + 1, 'القسم': d.department, 'المستشفى': d.hospital,
        'نسبة الحضور %': d.stats.rate === null ? '-' : Math.round(d.stats.rate),
        'حاضر': d.stats.present, 'غائب': d.stats.absent,
        'إجازة': d.stats.leave, 'منسحب': d.stats.withdrawn,
        'عدد التقارير': d.stats.count,
      }))), 'الأقسام');

    /* ورقة الملاحظات */
    const obs = Analytics.observations(ov);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(
      [['الملاحظات المولّدة آلياً'], [], ...obs.map((o, i) => [`${i + 1}. ${o.text}`])]), 'الملاحظات');

    XLSX.writeFile(wb, `تقرير_تنفيذي_${m.from}_${m.to}.xlsx`);
    Toast.show('تم تصدير ملف Excel بنجاح', 'success');
    DB.audit('تصدير Excel', `تقرير تنفيذي — ${m.from} إلى ${m.to}`);
  },
};

/* ======================================================
   تهيئة الصفحة — لا تعمل إلا في صفحة التقارير التنفيذية
   ====================================================== */
document.addEventListener('DOMContentLoaded', () => {
  if (document.body.dataset.page === 'exec-reports') ExecReports.init();
});
