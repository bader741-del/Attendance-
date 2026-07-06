/* ============================================================
   خريطة عمليات المستشفيات — الوحدة البرمجية (المرحلة 5)
   hospital-map.js
   ------------------------------------------------------------
   وحدة مستقلة تُحمَّل بعد script.js وanalytics-core.js وتعيد
   استخدام الطبقات القائمة دون أي تعديل عليها:
     - DB / Cloud / Sync          : البيانات (Supabase مصدر الحقيقة)
     - Theme / Toast / esc        : السمة والتنبيهات والتهريب
     - Analytics / AdminGate      : الحسابات والبوابة المشتركة
   كل الأرقام تُحسب آلياً من التقارير الفعلية — لا بيانات ثابتة.
   ============================================================ */

'use strict';

const HospitalMap = {

  /* بيانات العرض (أيقونة/لون/إحداثيات) — مُوحَّدة في الطبقة المشتركة */
  get META()       { return Analytics.HOSPITAL_META; },
  get THRESHOLDS() { return Analytics.THRESHOLDS; },

  /* حالة الوحدة */
  range: { from: null, to: null },   // نطاق التاريخ الحالي
  preset: 'today',                   // الفلتر النشط
  currentHospital: null,             // المستشفى المفتوح في المودال
  currentTab: 'daily',               // تبويب المودال النشط
  _charts: {},                       // مراجع Chart.js (للتدمير قبل إعادة الرسم)
  _leaflet: null,                    // مرجع خريطة Leaflet
  _markers: {},                      // علامات المستشفيات
  _pollTimer: null,
  _rtChannel: null,

  /* ======================================================
     1) التهيئة وبوابة الدخول — عبر AdminGate المشترك
     (بيانات التقارير محمية بـ RLS للمسؤول فقط)
     ====================================================== */
  _gateIds: { overlay: 'mapLogin', input: 'mapPassInput', error: 'mapLoginError' },

  init()   { AdminGate.init(this._gateIds, () => this._showApp()); },
  login()  { AdminGate.login(this._gateIds, () => this._showApp()); },
  logout() { AdminGate.logout(); },

  async _showApp() {
    document.getElementById('mapLogin').style.display = 'none';
    document.getElementById('mapContent').style.display = 'flex';

    this.applyPreset('today', false);
    this._initLeaflet();
    await this.refresh();       // سحب من Supabase ثم رسم
    this._initAutoRefresh();
  },

  /* ======================================================
     2) جلب البيانات — Supabase أولاً
     Sync.pullAll يجلب كل الجداول من السحابة ويحدّث ذاكرة
     العمل المحلية؛ بعدها تُحسب كل الأرقام من البيانات الحية.
     ====================================================== */
  async refresh(silent = true) {
    await Analytics.pull();   // سحب أحدث البيانات من Supabase
    this.renderAll();
    const stamp = document.getElementById('mapLastRefresh');
    if (stamp) stamp.textContent = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
    if (!silent) Toast.show('تم تحديث البيانات', 'success', 2000);
  },

  /* ======================================================
     3) التحديث التلقائي — عبر Analytics.autoRefresh المشترك
     (Realtime سحابياً + storage محلياً + سحب دوري احتياطي)
     ====================================================== */
  _initAutoRefresh() {
    if (!this._pollTimer)
      this._pollTimer = Analytics.autoRefresh('hospital-map-reports', () => this.refresh());
  },

  /* ======================================================
     4) الفلاتر الزمنية
     اليوم / أمس / هذا الأسبوع / هذا الشهر / نطاق مخصص
     ====================================================== */
  applyPreset(preset, rerender = true) {
    this.preset = preset;
    // النطاق من الطبقة المشتركة — 'custom' يبقى كما اختاره المستخدم
    if (preset !== 'custom') this.range = Analytics.rangeFor(preset);

    // تفعيل الشريحة النشطة وإظهار حقول النطاق المخصص
    document.querySelectorAll('.map-filter-chip').forEach(c =>
      c.classList.toggle('active', c.dataset.preset === preset));
    document.getElementById('mapCustomRange')?.classList.toggle('show', preset === 'custom');

    if (preset === 'custom') {
      const f = document.getElementById('mapFromDate'), x = document.getElementById('mapToDate');
      if (f && !f.value) f.value = this.range.from || DB.today();
      if (x && !x.value) x.value = this.range.to   || DB.today();
      this.range = { from: f?.value || DB.today(), to: x?.value || DB.today() };
    }

    const lbl = document.getElementById('mapRangeLabel');
    if (lbl) lbl.textContent = this.range.from === this.range.to
      ? `التاريخ: ${this.range.from}`
      : `الفترة: ${this.range.from} ← ${this.range.to}`;

    if (rerender) this.renderAll();
  },

  applyCustomRange() {
    const f = document.getElementById('mapFromDate')?.value;
    const t = document.getElementById('mapToDate')?.value;
    if (!f || !t) return Toast.show('حدد تاريخ البداية والنهاية', 'warning');
    if (f > t)    return Toast.show('تاريخ البداية بعد تاريخ النهاية', 'warning');
    this.range = { from: f, to: t };
    this.applyPreset('custom');
  },

  /* ======================================================
     5) الحسابات — مفوَّضة للطبقة المشتركة (Analytics)
     التقارير المرفوضة تُستبعد من الإحصاء (كما في بقية المنصة)
     ====================================================== */
  _reports(hospital = null, from = this.range.from, to = this.range.to) {
    return Analytics.reports({ from, to, hospital });
  },

  _stats(reports)  { return Analytics.sumStats(reports); },
  _statusOf(rate)  { return Analytics.statusOf(rate); },

  /* بيانات بطاقة مستشفى واحد */
  _hospitalData(h) {
    const reps  = this._reports(h);
    const stats = this._stats(reps);
    const all   = DB.getReports().filter(r => r.hospital === h);
    const pending = all.filter(r => r.status === 'pending').length;
    const last  = all.reduce((m, r) => (r.createdAt && (!m || r.createdAt > m)) ? r.createdAt : m, null);
    return {
      hospital: h,
      stats,
      employees: DB.getEmployees().filter(e => e.hospital === h).length,
      departments: DB.getDepartments().filter(d => d.hospital === h).length,
      pending,
      lastSubmit: last,
      status: this._statusOf(stats.rate),
    };
  },

  _fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' }) +
           ' ' + d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
  },

  /* ======================================================
     6) الرسم الرئيسي: البطاقات + علامات الخريطة
     ====================================================== */
  renderAll() {
    this.renderCards();
    this._updateMarkers();
    // إن كان المودال مفتوحاً حدّث محتواه بالبيانات الجديدة
    if (this.currentHospital && document.getElementById('hospDetailModal')?.classList.contains('open')) {
      this.renderDetail(this.currentHospital);
    }
  },

  renderCards() {
    const grid = document.getElementById('hospCardsGrid');
    if (!grid) return;

    grid.innerHTML = DB.HOSPITALS.map(h => {
      const d = this._hospitalData(h);
      const m = this.META[h] || { icon: 'fa-hospital', color: 'var(--secondary)' };
      const rateTxt = d.stats.rate === null ? '—' : Math.round(d.stats.rate) + '%';
      return `
      <div class="hosp-card ${d.status.cls}" onclick="HospitalMap.openDetail('${esc(h)}')"
           role="button" tabindex="0" aria-label="تفاصيل ${esc(h)}"
           onkeydown="if(event.key==='Enter')HospitalMap.openDetail('${esc(h)}')">
        <div class="hosp-card-head">
          <div class="hosp-card-icon" style="background:${m.color}"><i class="fas ${m.icon}"></i></div>
          <div>
            <div class="hosp-card-name">${esc(h)}</div>
            <div class="hosp-card-sub">${d.departments} قسم · ${d.employees} موظف مسجَّل</div>
          </div>
          <span class="hosp-status-badge ${d.status.cls}">${d.status.emoji} ${d.status.label}</span>
        </div>

        <div>
          <div class="hosp-rate-row">
            <span class="hosp-rate-val ${d.status.cls}">${rateTxt}</span>
            <span class="hosp-rate-label">نسبة الحضور — ${d.stats.count} تقرير في الفترة</span>
          </div>
          <div class="hosp-progress" style="margin-top:8px">
            <div class="hosp-progress-fill ${d.status.cls}" style="width:${d.stats.rate === null ? 0 : Math.min(100, Math.round(d.stats.rate))}%"></div>
          </div>
        </div>

        <div class="hosp-stats">
          <div class="hosp-stat c-present"><b>${d.stats.present}</b><span>حاضر</span></div>
          <div class="hosp-stat c-absent"><b>${d.stats.absent}</b><span>غائب</span></div>
          <div class="hosp-stat c-leave"><b>${d.stats.leave}</b><span>إجازة</span></div>
          <div class="hosp-stat c-withdrawn"><b>${d.stats.withdrawn}</b><span>منسحب</span></div>
          <div class="hosp-stat c-pending"><b>${d.pending}</b><span>بانتظار الاعتماد</span></div>
          <div class="hosp-stat"><b>${d.stats.denom}</b><span>إجمالي المرصود</span></div>
        </div>

        <div class="hosp-card-foot">
          <span><i class="fas fa-clock" style="margin-left:4px"></i>آخر تقرير: ${this._fmtDateTime(d.lastSubmit)}</span>
          <span class="open-hint">التفاصيل <i class="fas fa-arrow-left"></i></span>
        </div>
      </div>`;
    }).join('');
  },

  /* ======================================================
     7) خريطة Leaflet — مواقع المستشفيات
     تعمل فقط إن حُمّلت المكتبة؛ وإلا تبقى لوحة البطاقات وحدها
     (المتطلب: تخطيط احترافي بديل عند غياب الخريطة)
     ====================================================== */
  _initLeaflet() {
    const el = document.getElementById('hospLeafletMap');
    if (!el) return;
    if (typeof L === 'undefined') {           // المكتبة غير متاحة (دون اتصال مثلاً)
      document.getElementById('mapLeafletCard').style.display = 'none';
      return;
    }
    const coords = Object.values(this.META).map(m => m.coords);
    this._leaflet = L.map(el, { scrollWheelZoom: false }).fitBounds(coords, { padding: [40, 40] });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    }).addTo(this._leaflet);

    DB.HOSPITALS.forEach(h => {
      const m = this.META[h];
      if (!m) return;
      const marker = L.marker(m.coords, { icon: this._markerIcon(m, 'status-none') }).addTo(this._leaflet);
      marker.on('click', () => this.openDetail(h));
      this._markers[h] = marker;
    });
  },

  /* أيقونة علامة ملوّنة حسب حالة المستشفى */
  _markerIcon(meta, statusCls) {
    const colors = { 'status-green': '#27ae60', 'status-yellow': '#e67e22', 'status-red': '#e74c3c', 'status-none': '#8a9ab0' };
    return L.divIcon({
      className: '',
      html: `<div class="hosp-marker" style="background:${colors[statusCls]}"><i class="fas ${meta.icon}"></i></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 38],
      popupAnchor: [0, -40],
    });
  },

  /* تحديث ألوان العلامات والنوافذ المنبثقة بعد كل حساب */
  _updateMarkers() {
    if (!this._leaflet) return;
    DB.HOSPITALS.forEach(h => {
      const marker = this._markers[h];
      if (!marker) return;
      const d = this._hospitalData(h);
      const m = this.META[h];
      marker.setIcon(this._markerIcon(m, d.status.cls));
      marker.bindPopup(`
        <div style="min-width:170px">
          <b style="font-size:13px">${esc(h)}</b><br>
          <span style="font-size:12px">${d.status.emoji} الحضور: <b>${d.stats.rate === null ? '—' : Math.round(d.stats.rate) + '%'}</b></span><br>
          <span style="font-size:12px">حاضر ${d.stats.present} · غائب ${d.stats.absent} · معلّق ${d.pending}</span>
        </div>`);
    });
  },

  /* ======================================================
     8) المودال التفصيلي: أقسام + رسوم + تقارير
     ====================================================== */
  openDetail(hospital) {
    this.currentHospital = hospital;
    document.getElementById('hospDetailModal')?.classList.add('open');
    this.renderDetail(hospital);
  },

  closeDetail() {
    document.getElementById('hospDetailModal')?.classList.remove('open');
    this.currentHospital = null;
  },

  renderDetail(h) {
    const d = this._hospitalData(h);
    const m = this.META[h] || {};

    // الترويسة
    const title = document.getElementById('hospDetailTitle');
    if (title) title.innerHTML =
      `<i class="fas ${m.icon || 'fa-hospital'}" style="color:${m.color || 'var(--secondary)'}"></i> ${esc(h)}
       <span class="hosp-status-badge ${d.status.cls}" style="margin-right:8px">${d.status.emoji} ${d.status.label}</span>`;

    const sub = document.getElementById('hospDetailRange');
    if (sub) sub.textContent = this.range.from === this.range.to
      ? `بيانات يوم ${this.range.from}` : `بيانات الفترة ${this.range.from} ← ${this.range.to}`;

    // مؤشرات سريعة
    const kpis = document.getElementById('hospDetailKpis');
    if (kpis) kpis.innerHTML = `
      <div class="hosp-stat"><b style="color:${d.stats.rate === null ? 'var(--text-muted)' : ''}">${d.stats.rate === null ? '—' : Math.round(d.stats.rate) + '%'}</b><span>نسبة الحضور</span></div>
      <div class="hosp-stat c-present"><b>${d.stats.present}</b><span>حاضر</span></div>
      <div class="hosp-stat c-absent"><b>${d.stats.absent}</b><span>غائب</span></div>
      <div class="hosp-stat c-leave"><b>${d.stats.leave}</b><span>إجازة</span></div>
      <div class="hosp-stat c-withdrawn"><b>${d.stats.withdrawn}</b><span>منسحب</span></div>
      <div class="hosp-stat c-pending"><b>${d.pending}</b><span>بانتظار الاعتماد</span></div>`;

    this._renderDeptTable(h);
    this._renderDeptHighlights(h);
    this._renderTrendChart(h);
    this._renderDeptChart(h);
    this.showTab(this.currentTab || 'daily');
  },

  /* ---- ترتيب الأقسام: الأفضل أداءً / الأكثر غياباً ---- */
  _renderDeptHighlights(h) {
    const best = document.getElementById('hospBestDepts');
    const worst = document.getElementById('hospAbsentDepts');
    if (!best || !worst) return;

    const reps = this._reports(h);
    const stats = [...new Set(reps.map(r => r.department))].filter(Boolean).map(dept => ({
      dept,
      s: this._stats(reps.filter(r => r.department === dept)),
    })).filter(x => x.s.rate !== null);

    const row = (x, val, color, icon) => `
      <div class="hosp-rank-row">
        <i class="fas ${icon}" style="color:${color}"></i>
        <span class="hosp-rank-name">${esc(x.dept)}</span>
        <span class="hosp-rank-val" style="color:${color}">${val}</span>
      </div>`;
    const empty = `<div style="font-size:12px;color:var(--text-muted);padding:8px 2px">لا توجد بيانات في الفترة</div>`;

    // الأفضل أداءً: أعلى نسبة حضور (أفضل 3)
    const top = [...stats].sort((a, b) => b.s.rate - a.s.rate).slice(0, 3);
    best.innerHTML = top.length
      ? top.map((x, i) => row(x, Math.round(x.s.rate) + '%', 'var(--success)',
          i === 0 ? 'fa-trophy' : i === 1 ? 'fa-medal' : 'fa-award')).join('')
      : empty;

    // الأكثر غياباً: أعلى نسبة غياب (أعلى 3، غياب > 0)
    const abs = [...stats].filter(x => x.s.absent > 0)
      .sort((a, b) => b.s.absenceRate - a.s.absenceRate).slice(0, 3);
    worst.innerHTML = abs.length
      ? abs.map(x => row(x, Math.round(x.s.absenceRate) + '%', 'var(--danger)', 'fa-user-xmark')).join('')
      : empty;
  },

  /* ---- جدول إحصائيات الأقسام ---- */
  _renderDeptTable(h) {
    const body = document.getElementById('hospDeptBody');
    if (!body) return;
    const reps = this._reports(h);
    const depts = [...new Set([
      ...DB.getDepartments().filter(d => d.hospital === h).map(d => d.name),
      ...reps.map(r => r.department),
    ])].filter(Boolean);

    if (!depts.length) {
      body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:18px">لا توجد أقسام أو تقارير في هذه الفترة</td></tr>`;
      return;
    }
    body.innerHTML = depts.map(dept => {
      const s = this._stats(reps.filter(r => r.department === dept));
      const st = this._statusOf(s.rate);
      return `
        <tr>
          <td><strong>${esc(dept)}</strong></td>
          <td><span style="color:var(--success);font-weight:700">${s.present}</span></td>
          <td><span style="color:var(--danger);font-weight:700">${s.absent}</span></td>
          <td>${s.leave}</td>
          <td>${s.withdrawn}</td>
          <td>${s.rate === null ? '—' : Math.round(s.rate) + '%'}</td>
          <td>${st.emoji} ${st.label}</td>
        </tr>`;
    }).join('');
  },

  /* ---- رسم Chart.js — عبر المساعد المشترك ---- */
  _chart(id, config) { Analytics.chart(this._charts, id, config); },

  /* ---- اتجاه الحضور عبر أيام الفترة (خطي) ---- */
  _renderTrendChart(h) {
    // أيام النطاق (بحد أقصى 62 يوماً حمايةً للأداء)
    const days = Analytics.days(this.range.from, this.range.to, 62);
    const reps = this._reports(h);
    const per = days.map(day => this._stats(reps.filter(r => r.date === day)));

    this._chart('hospChartTrend', {
      type: 'line',
      data: {
        labels: days.map(x => x.slice(5)),
        datasets: [
          { label: 'حاضر', data: per.map(s => s.present), borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,.12)', fill: true, tension: .35 },
          { label: 'غائب', data: per.map(s => s.absent), borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,.10)', fill: true, tension: .35 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', rtl: true } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  },

  /* ---- نسبة الحضور حسب القسم (أعمدة) ---- */
  _renderDeptChart(h) {
    const reps = this._reports(h);
    const depts = [...new Set(reps.map(r => r.department))].filter(Boolean);
    const rates = depts.map(dept => {
      const s = this._stats(reps.filter(r => r.department === dept));
      return s.rate === null ? 0 : Math.round(s.rate);
    });
    const colors = rates.map(r => r >= this.THRESHOLDS.green ? '#27ae60' : r >= this.THRESHOLDS.yellow ? '#e67e22' : '#e74c3c');

    this._chart('hospChartDepts', {
      type: 'bar',
      data: {
        labels: depts.length ? depts : ['لا بيانات'],
        datasets: [{ label: 'نسبة الحضور %', data: depts.length ? rates : [0], backgroundColor: depts.length ? colors : ['#8a9ab0'], borderRadius: 6 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } },
      },
    });
  },

  /* ======================================================
     9) تبويبات التقارير داخل المودال
     يومي: تقارير اليوم — أسبوعي: تجميع أيام الأسبوع الحالي
     شهري: تجميع أيام الشهر الحالي — كلها للمستشفى المفتوح
     ====================================================== */
  showTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.hosp-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));

    const h = this.currentHospital;
    const head = document.getElementById('hospTabHead');
    const body = document.getElementById('hospTabBody');
    if (!h || !head || !body) return;

    const empty = (cols, msg) =>
      `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-muted);padding:18px">${msg}</td></tr>`;

    if (tab === 'daily') {
      /* تقارير اليوم واحدة واحدة */
      const reps = this._reports(h, DB.today(), DB.today());
      head.innerHTML = `<tr><th>القسم</th><th>الفترة</th><th>حاضر</th><th>غائب</th><th>إجازة</th><th>منسحب</th><th>الحالة</th><th>أدخله</th></tr>`;
      body.innerHTML = reps.length ? reps.map(r => `
        <tr>
          <td><strong>${esc(r.department)}</strong></td>
          <td>${esc(r.period || '—')}</td>
          <td style="color:var(--success);font-weight:700">${+r.present || 0}</td>
          <td style="color:var(--danger);font-weight:700">${+r.absent || 0}</td>
          <td>${+r.leave || 0}</td>
          <td>${+r.withdrawn || 0}</td>
          <td>${r.status === 'approved' ? '<span class="badge badge-success">معتمد</span>' : '<span class="badge badge-primary">معلّق</span>'}</td>
          <td>${esc(r.enteredBy || '—')}</td>
        </tr>`).join('') : empty(8, 'لا توجد تقارير اليوم لهذا المستشفى');
      return;
    }

    /* أسبوعي/شهري: صف لكل يوم في النطاق */
    const range = tab === 'weekly'
      ? DB.weekRange()
      : { from: DB.thisMonth() + '-01', to: DB.localISO(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)) };

    const days = Analytics.days(range.from, range.to, 62);
    const reps = this._reports(h, range.from, range.to);
    head.innerHTML = `<tr><th>التاريخ</th><th>تقارير</th><th>حاضر</th><th>غائب</th><th>إجازة</th><th>منسحب</th><th>نسبة الحضور</th><th>الحالة</th></tr>`;
    const rows = days.map(day => {
      const s = this._stats(reps.filter(r => r.date === day));
      if (!s.count) return '';
      const st = this._statusOf(s.rate);
      return `
        <tr>
          <td><strong>${day}</strong></td>
          <td>${s.count}</td>
          <td style="color:var(--success);font-weight:700">${s.present}</td>
          <td style="color:var(--danger);font-weight:700">${s.absent}</td>
          <td>${s.leave}</td>
          <td>${s.withdrawn}</td>
          <td>${s.rate === null ? '—' : Math.round(s.rate) + '%'}</td>
          <td>${st.emoji} ${st.label}</td>
        </tr>`;
    }).filter(Boolean).join('');
    body.innerHTML = rows || empty(8, tab === 'weekly' ? 'لا توجد تقارير هذا الأسبوع' : 'لا توجد تقارير هذا الشهر');
  },
};

/* ======================================================
   تهيئة الصفحة — لا تعمل إلا في صفحة الخريطة
   (script.js يهيّئ Cloud وTheme لكل الصفحات قبلها)
   ====================================================== */
document.addEventListener('DOMContentLoaded', () => {
  if (document.body.dataset.page === 'map') HospitalMap.init();
});
