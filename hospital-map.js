/* ============================================================
   خريطة عمليات المستشفيات — الوحدة البرمجية (المرحلة 5)
   hospital-map.js
   ------------------------------------------------------------
   وحدة مستقلة تُحمَّل بعد script.js وتعيد استخدام طبقاته القائمة
   دون أي تعديل عليها:
     - DB    : القراءة المحلية (ذاكرة العمل)
     - Cloud : عميل Supabase
     - Sync  : السحب من السحابة (Supabase مصدر الحقيقة)
     - Theme / Toast / esc : السمة والتنبيهات والتهريب
   كل الأرقام تُحسب آلياً من التقارير الفعلية — لا بيانات ثابتة.
   ============================================================ */

'use strict';

const HospitalMap = {

  /* ======================================================
     الإعدادات الثابتة للعرض فقط (أيقونة/لون/إحداثيات)
     الإحداثيات تقريبية لمجمع مدينة الملك سلمان الطبية
     بالمدينة المنورة — عدّلها هنا عند توفر إحداثيات أدق.
     ====================================================== */
  META: {
    'مستشفى المدينة الرئيسي':  { icon: 'fa-hospital', color: '#2980b9', en: 'Main Hospital',                coords: [24.4861, 39.5799] },
    'مستشفى النساء والأطفال': { icon: 'fa-baby',     color: '#8e44ad', en: 'Maternity & Children Hospital', coords: [24.4838, 39.5758] },
    'مستشفى الطب النفسي':     { icon: 'fa-brain',    color: '#16a085', en: 'Mental Health Hospital',        coords: [24.4895, 39.5846] },
  },

  /* حدود ألوان الحالة: أخضر ≥95، أصفر 85–94، أحمر <85 */
  THRESHOLDS: { green: 95, yellow: 85 },

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
     1) التهيئة وبوابة الدخول
     نفس منطق لوحة المسؤول: مصادقة Supabase عند تفعيل السحابة،
     وإلا كلمة المرور المحلية. (بيانات التقارير محمية بـ RLS
     للمسؤول فقط، لذا الصفحة خلف بوابة دخول المسؤول)
     ====================================================== */
  init() {
    if (DB.isAdminLoggedIn()) { this._showApp(); return; }

    document.getElementById('mapLogin').style.display = 'flex';
    const inp = document.getElementById('mapPassInput');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });

    // استعادة جلسة سحابية سابقة إن وُجدت (كما في لوحة المسؤول)
    if (Cloud.on()) {
      Cloud.sb.auth.getSession().then(({ data }) => {
        if (data?.session) { DB.setAdminSession(); this._showApp(); }
      }).catch(() => {});
    }
  },

  async login() {
    const inp = document.getElementById('mapPassInput');
    const err = document.getElementById('mapLoginError');
    if (!inp || !err) return;

    let ok;
    if (Cloud.on()) {
      try {
        const { error } = await Cloud.sb.auth.signInWithPassword({
          email: SUPABASE_CONFIG.adminEmail,
          password: inp.value,
        });
        ok = !error;
      } catch { ok = false; }
    } else {
      ok = await DB.verifyPass(inp.value);
    }

    if (ok) {
      DB.setAdminSession();
      DB.audit('تسجيل دخول المسؤول', 'دخول عبر خريطة العمليات');
      err.classList.remove('show');
      this._showApp();
    } else {
      err.classList.add('show');
      inp.value = '';
      inp.focus();
    }
  },

  logout() {
    const bye = () => { DB.clearAdminSession(); location.href = 'index.html'; };
    if (Cloud.on()) Cloud.sb.auth.signOut().then(bye).catch(bye);
    else bye();
  },

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
    if (Cloud.on()) {
      try { await Sync.pullAll(); } catch { /* دون اتصال — آخر نسخة معروفة */ }
    }
    this.renderAll();
    const stamp = document.getElementById('mapLastRefresh');
    if (stamp) stamp.textContent = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
    if (!silent) Toast.show('تم تحديث البيانات', 'success', 2000);
  },

  /* ======================================================
     3) التحديث التلقائي عند وصول بيانات جديدة
     - سحابة: قناة Realtime على جدول reports (أي إدراج/تعديل)
     - محلي : حدث storage (إدخال موظف من تبويب آخر)
     - شبكة أمان: سحب دوري كل 60 ثانية + تحديث عند العودة للتبويب
     ====================================================== */
  _initAutoRefresh() {
    // قناة Supabase Realtime
    if (Cloud.on() && !this._rtChannel) {
      try {
        this._rtChannel = Cloud.sb
          .channel('hospital-map-reports')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' },
              () => this._debouncedRefresh())
          .subscribe();
      } catch { /* Realtime غير مفعّل — يكفي السحب الدوري */ }
    }

    // الوضع المحلي: تقرير جديد كُتب في localStorage من تبويب آخر
    window.addEventListener('storage', e => {
      if (e.key === DB._k.reports) this._debouncedRefresh();
    });

    // العودة إلى التبويب
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.refresh();
    });

    // سحب دوري احتياطي
    if (!this._pollTimer) this._pollTimer = setInterval(() => this.refresh(), 60000);
  },

  _debounce: null,
  _debouncedRefresh() {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.refresh(), 800);
  },

  /* ======================================================
     4) الفلاتر الزمنية
     اليوم / أمس / هذا الأسبوع / هذا الشهر / نطاق مخصص
     ====================================================== */
  applyPreset(preset, rerender = true) {
    this.preset = preset;
    const t = new Date();
    const iso = d => DB.localISO(d);

    if (preset === 'today') {
      this.range = { from: DB.today(), to: DB.today() };
    } else if (preset === 'yesterday') {
      const y = new Date(t); y.setDate(t.getDate() - 1);
      this.range = { from: iso(y), to: iso(y) };
    } else if (preset === 'week') {
      this.range = DB.weekRange();
    } else if (preset === 'month') {
      const first = new Date(t.getFullYear(), t.getMonth(), 1);
      const last  = new Date(t.getFullYear(), t.getMonth() + 1, 0);
      this.range = { from: iso(first), to: iso(last) };
    }
    // preset === 'custom' : يبقى النطاق كما اختاره المستخدم

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
     5) الحسابات — كلها آلية من التقارير الفعلية
     التقارير المرفوضة تُستبعد من الإحصاء (كما في بقية المنصة)
     ====================================================== */
  _reports(hospital = null, from = this.range.from, to = this.range.to) {
    let list = DB.getReports().filter(r =>
      r.date >= from && r.date <= to && r.status !== 'rejected');
    if (hospital) list = list.filter(r => r.hospital === hospital);
    return list;
  },

  /* إحصائية مجمّعة لمجموعة تقارير */
  _stats(reports) {
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
      rate: denom ? (t.present / denom) * 100 : null,   // null = لا بيانات
      count: reports.length,
    };
  },

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

  /* تصنيف الحالة اللونية حسب نسبة الحضور */
  _statusOf(rate) {
    if (rate === null)                  return { cls: 'status-none',   label: 'لا توجد بيانات', emoji: '⚪' };
    if (rate >= this.THRESHOLDS.green)  return { cls: 'status-green',  label: 'ممتاز',          emoji: '🟢' };
    if (rate >= this.THRESHOLDS.yellow) return { cls: 'status-yellow', label: 'يحتاج متابعة',   emoji: '🟡' };
    return                                     { cls: 'status-red',    label: 'حرج',            emoji: '🔴' };
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
    this._renderTrendChart(h);
    this._renderDeptChart(h);
    this.showTab(this.currentTab || 'daily');
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

  /* ---- رسم Chart.js مع تدمير النسخة السابقة ---- */
  _chart(id, config) {
    const cv = document.getElementById(id);
    if (!cv || typeof Chart === 'undefined') return;
    if (this._charts[id]) this._charts[id].destroy();
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-light').trim();
    Chart.defaults.color = muted;
    Chart.defaults.font.family = 'Cairo, sans-serif';
    this._charts[id] = new Chart(cv.getContext('2d'), config);
  },

  /* ---- اتجاه الحضور عبر أيام الفترة (خطي) ---- */
  _renderTrendChart(h) {
    // أيام النطاق (بحد أقصى 62 يوماً حمايةً للأداء)
    const days = [];
    const d = new Date(this.range.from + 'T00:00:00');
    const end = new Date(this.range.to + 'T00:00:00');
    while (d <= end && days.length < 62) { days.push(DB.localISO(d)); d.setDate(d.getDate() + 1); }

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

    const days = [];
    const d = new Date(range.from + 'T00:00:00');
    const end = new Date(range.to + 'T00:00:00');
    while (d <= end && days.length < 62) { days.push(DB.localISO(d)); d.setDate(d.getDate() + 1); }

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
