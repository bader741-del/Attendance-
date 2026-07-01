/* ============================================================
   منصة مراقبة الدوام - مدينة الملك سلمان الطبية
   script.js - المنطق البرمجي الكامل (متصل بـ Supabase)
   ============================================================ */

'use strict';

/* ======================================================
   اتصال Supabase
   ====================================================== */
const _sbClient = (typeof window !== 'undefined' && window.supabase &&
  typeof SUPABASE_CONFIG !== 'undefined' &&
  SUPABASE_CONFIG.url && !SUPABASE_CONFIG.url.includes('YOUR-PROJECT'))
  ? window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey)
  : null;

/* ======================================================
   طبقة قاعدة البيانات (Supabase)
   ====================================================== */
const DB = {
  HOSPITALS: [
    'مستشفى الطب النفسي',
    'مستشفى النساء والأطفال',
    'مستشفى المدينة الرئيسي',
  ],

  DAYS: ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'],

  /* قائمة الأقسام القياسية الافتراضية — تُزرع تلقائياً أول مرة فقط.
     يمكن للمسؤول لاحقاً إضافة/حذف أي قسم يدوياً من لوحة التحكم. */
  DEFAULT_DEPARTMENTS: {
    'مستشفى الطب النفسي': [
      'الطوارئ',
      'العناية المركزة',
      'التنويم',
      'العيادات الخارجية',
      'المختبر',
      'الصيدلية',
    ],
    'مستشفى النساء والأطفال': [
      'الولادة',
      'الحضانات',
      'الأطفال',
      'النساء',
      'الطوارئ',
      'العمليات',
    ],
    'مستشفى المدينة الرئيسي': [
      'الطوارئ',
      'التنويم',
      'العناية المركزة',
      'الجراحة',
      'الباطنية',
      'المختبر',
      'الأشعة',
    ],
  },

  _ensure() {
    if (!_sbClient) {
      Toast?.show?.('لم يتم إعداد الاتصال بقاعدة البيانات — راجع ملف config.js', 'error', 6000);
      console.error('Supabase غير مُهيأ. تأكد من تحميل مكتبة supabase-js وتعبئة config.js بالبيانات الصحيحة.');
      return false;
    }
    return true;
  },

  /* ---- جلسات (تبقى محلية في المتصفح) ---- */
  setAdminSession()   { sessionStorage.setItem('mksh_admin_session', '1'); },
  clearAdminSession() { sessionStorage.removeItem('mksh_admin_session'); },
  isAdminLoggedIn()   { return sessionStorage.getItem('mksh_admin_session') === '1'; },

  setEmpSession(emp)   { sessionStorage.setItem('mksh_emp_session', JSON.stringify(emp)); },
  clearEmpSession()    { sessionStorage.removeItem('mksh_emp_session'); },
  getEmpSession()      { try { const v = sessionStorage.getItem('mksh_emp_session'); return v ? JSON.parse(v) : null; } catch { return null; } },

  /* ---- كلمة مرور المسؤول ---- */
  async getPass() {
    if (!this._ensure()) return 'admin1234';
    const { data, error } = await _sbClient.from('settings').select('admin_password').eq('id', 1).single();
    if (error) { console.error(error); return 'admin1234'; }
    return data?.admin_password || 'admin1234';
  },
  async setPass(p) {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('settings').update({ admin_password: p }).eq('id', 1);
    if (error) console.error(error);
  },

  /* ---- موظفون ---- */
  async getEmployees() {
    if (!this._ensure()) return [];
    const { data, error } = await _sbClient.from('employees').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); return []; }
    return data.map(this._mapEmpOut);
  },
  async addEmployee(data) {
    if (!this._ensure()) return { ok: false, msg: 'قاعدة البيانات غير متصلة' };
    const dup = await _sbClient.from('employees').select('id').eq('code', data.code).maybeSingle();
    if (dup.data) return { ok: false, msg: 'الكود مستخدم بالفعل' };
    const { error } = await _sbClient.from('employees').insert({ name: data.name, code: data.code, hospital: data.hospital || null, department: data.department || null });
    if (error) return { ok: false, msg: 'حدث خطأ أثناء الحفظ' };
    return { ok: true };
  },
  async updateEmployee(id, data) {
    if (!this._ensure()) return { ok: false, msg: 'قاعدة البيانات غير متصلة' };
    const dup = await _sbClient.from('employees').select('id').eq('code', data.code).neq('id', id).maybeSingle();
    if (dup.data) return { ok: false, msg: 'الكود مستخدم بالفعل' };
    const { error } = await _sbClient.from('employees').update({ name: data.name, code: data.code, hospital: data.hospital || null, department: data.department || null }).eq('id', id);
    if (error) return { ok: false, msg: 'الموظف غير موجود' };
    return { ok: true };
  },
  async deleteEmployee(id) {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('employees').delete().eq('id', id);
    if (error) console.error(error);
  },
  async findByCode(code) {
    if (!this._ensure()) return null;
    const { data, error } = await _sbClient.from('employees').select('*').eq('code', code.trim().toUpperCase()).maybeSingle();
    if (error) { console.error(error); return null; }
    return data ? this._mapEmpOut(data) : null;
  },
  _mapEmpOut(e) { return { id: e.id, name: e.name, code: e.code, hospital: e.hospital, department: e.department, createdAt: e.created_at }; },

  /* ---- أقسام ---- */
  async getDepartments() {
    if (!this._ensure()) return [];
    const { data, error } = await _sbClient.from('departments').select('*').order('hospital').order('name');
    if (error) { console.error(error); return []; }
    return data.map(this._mapDeptOut);
  },
  async addDepartment(data) {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('departments').insert({ name: data.name, hospital: data.hospital });
    if (error) console.error(error);
  },
  async deleteDepartment(id) {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('departments').delete().eq('id', id);
    if (error) console.error(error);
  },
  async getDeptsByHospital(hosp) {
    if (!this._ensure()) return [];
    const { data, error } = await _sbClient.from('departments').select('*').eq('hospital', hosp).order('name');
    if (error) { console.error(error); return []; }
    return data.map(this._mapDeptOut);
  },
  _mapDeptOut(d) { return { id: d.id, name: d.name, hospital: d.hospital, createdAt: d.created_at }; },

  /* زرع الأقسام الافتراضية أول مرة فقط (إن لم توجد أي أقسام محفوظة) */
  async seedDefaultDepartmentsIfEmpty() {
    if (!this._ensure()) return;
    const { count, error } = await _sbClient.from('departments').select('id', { count: 'exact', head: true });
    if (error) { console.error(error); return; }
    if (count && count > 0) return;
    const rows = [];
    Object.entries(this.DEFAULT_DEPARTMENTS).forEach(([hospital, names]) => {
      names.forEach(name => rows.push({ name, hospital }));
    });
    if (!rows.length) return;
    const { error: insErr } = await _sbClient.from('departments').insert(rows);
    if (insErr) console.error(insErr);
  },

  /* ---- جداول دوام ---- */
  async getShifts() {
    if (!this._ensure()) return [];
    const { data, error } = await _sbClient.from('shifts').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); return []; }
    return data.map(this._mapShiftOut);
  },
  async addShift(data) {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('shifts').insert({ hospital: data.hospital, department: data.department, period: data.period, required_count: data.requiredCount });
    if (error) console.error(error);
  },
  async updateShift(id, data) {
    if (!this._ensure()) return false;
    const { error } = await _sbClient.from('shifts').update({ hospital: data.hospital, department: data.department, period: data.period, required_count: data.requiredCount }).eq('id', id);
    return !error;
  },
  async deleteShift(id) {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('shifts').delete().eq('id', id);
    if (error) console.error(error);
  },
  _mapShiftOut(s) { return { id: s.id, hospital: s.hospital, department: s.department, period: s.period, requiredCount: s.required_count, createdAt: s.created_at }; },

  /* ---- تقارير ---- */
  async getReports() {
    if (!this._ensure()) return [];
    const { data, error } = await _sbClient.from('reports').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); return []; }
    return data.map(this._mapReportOut);
  },
  async addReport(data) {
    if (!this._ensure()) return null;
    const row = {
      date: data.date, day: data.day, period: data.period, hospital: data.hospital, department: data.department,
      total: data.total, present: data.present, absent: data.absent, withdrawn: data.withdrawn,
      leave_count: data.leave, absent_names: data.absentNames || null, notes: data.notes || null,
      entered_by: data.enteredBy || null, employee_code: data.employeeCode || null, status: 'pending',
    };
    const { data: inserted, error } = await _sbClient.from('reports').insert(row).select().single();
    if (error) { console.error(error); return null; }
    return this._mapReportOut(inserted);
  },
  async approveReport(id) {
    if (!this._ensure()) return false;
    const { error } = await _sbClient.from('reports').update({ status: 'approved', approved_at: this._now() }).eq('id', id);
    return !error;
  },
  async rejectReport(id, reason) {
    if (!this._ensure()) return false;
    const { error } = await _sbClient.from('reports').update({ status: 'rejected', rejection_reason: reason, rejected_at: this._now() }).eq('id', id);
    return !error;
  },
  async deleteReport(id) {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('reports').delete().eq('id', id);
    if (error) console.error(error);
  },
  async clearReports() {
    if (!this._ensure()) return;
    const { error } = await _sbClient.from('reports').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) console.error(error);
  },
  _mapReportOut(r) {
    return {
      id: r.id, date: r.date, day: r.day, period: r.period, hospital: r.hospital, department: r.department,
      total: r.total, present: r.present, absent: r.absent, withdrawn: r.withdrawn, leave: r.leave_count,
      absentNames: r.absent_names, notes: r.notes, enteredBy: r.entered_by, employeeCode: r.employee_code,
      status: r.status, rejectionReason: r.rejection_reason, createdAt: r.created_at,
      approvedAt: r.approved_at, rejectedAt: r.rejected_at,
    };
  },

  /* ---- مساعدات ---- */
  _now() { return new Date().toISOString(); },

  getDayName(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return this.DAYS[d.getDay()];
  },
  formatDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleDateString('ar-SA');
  },
  today() {
    return new Date().toISOString().slice(0, 10);
  },
  thisMonth() {
    return new Date().toISOString().slice(0, 7);
  },
  weekRange() {
    const now = new Date();
    const day = now.getDay();
    const sun = new Date(now); sun.setDate(now.getDate() - day);
    const sat = new Date(now); sat.setDate(now.getDate() + (6 - day));
    return { from: sun.toISOString().slice(0,10), to: sat.toISOString().slice(0,10) };
  },
};

/* ======================================================
   نظام الإشعارات Toast
   ====================================================== */
const Toast = {
  show(msg, type = 'success', duration = 3500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<i class="fas ${icons[type] || icons.success}"></i><span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => { t.classList.add('hiding'); setTimeout(() => t.remove(), 300); }, duration);
  },
};

/* ======================================================
   لوحة تحكم المسؤول
   ====================================================== */
const AdminApp = {
  currentSection: 'dashboard',

  async init() {
    if (!DB.isAdminLoggedIn()) {
      document.getElementById('adminLogin').style.display = 'flex';
      document.getElementById('adminContent').style.display = 'none';
      const inp = document.getElementById('adminPassInput');
      if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });
    } else {
      await this._showApp();
    }
  },

  async login() {
    const inp = document.getElementById('adminPassInput');
    const err = document.getElementById('loginError');
    if (!inp || !err) return;
    const pass = await DB.getPass();
    if (inp.value === pass) {
      DB.setAdminSession();
      err.classList.remove('show');
      await this._showApp();
    } else {
      err.classList.add('show');
      inp.value = '';
      inp.focus();
    }
  },

  logout() {
    DB.clearAdminSession();
    location.reload();
  },

  async _showApp() {
    document.getElementById('adminLogin').style.display = 'none';
    document.getElementById('adminContent').style.display = 'flex';
    document.getElementById('currentDateDisplay').textContent = new Date().toLocaleDateString('ar-SA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    // ضبط التواريخ الافتراضية
    const daily = document.getElementById('dailyDate');
    if (daily) daily.value = DB.today();
    const monthInput = document.getElementById('monthlyMonth');
    if (monthInput) monthInput.value = DB.thisMonth();
    const wr = DB.weekRange();
    const wf = document.getElementById('weeklyFrom');
    const wt = document.getElementById('weeklyTo');
    if (wf) wf.value = wr.from;
    if (wt) wt.value = wr.to;

    await DB.seedDefaultDepartmentsIfEmpty();
    await this.showSection('dashboard');
    await this._updatePendingBadge();
  },

  async showSection(name) {
    document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const sec = document.getElementById(`sec-${name}`);
    if (sec) sec.classList.add('active');
    const nav = document.querySelector(`.nav-item[data-section="${name}"]`);
    if (nav) nav.classList.add('active');
    this.currentSection = name;

    const titles = {
      dashboard: 'لوحة التحكم', employees: 'أكواد الموظفين', shifts: 'جداول الدوام',
      departments: 'إدارة الأقسام', reports: 'سجل التقارير',
      daily: 'التقرير اليومي', weekly: 'التقرير الأسبوعي', monthly: 'التقرير الشهري',
      settings: 'الإعدادات',
    };
    const el = document.getElementById('topBarTitle');
    if (el) el.textContent = titles[name] || name;

    const loaders = {
      dashboard:   () => this.loadDashboard(),
      employees:   () => this.renderEmployees(),
      shifts:      () => this.renderShifts(),
      departments: () => this.renderDepts(),
      reports:     () => this.renderReports(),
      daily:       () => this.renderDailyReport(),
      weekly:      () => this.renderWeeklyReport(),
      monthly:     () => this.renderMonthlyReport(),
    };
    if (loaders[name]) await loaders[name]();

    // إغلاق sidebar على الجوال
    if (window.innerWidth <= 768) this.closeSidebar();
  },

  toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebarOverlay');
    sb.classList.toggle('open');
    ov.classList.toggle('show');
  },
  closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('show');
  },

  async _updatePendingBadge() {
    const reports = await DB.getReports();
    const pending = reports.filter(r => r.status === 'pending').length;
    const badge = document.getElementById('pendingBadge');
    if (!badge) return;
    if (pending > 0) { badge.style.display = 'inline'; badge.textContent = pending; }
    else { badge.style.display = 'none'; }
  },

  /* ====== لوحة التحكم ====== */
  async loadDashboard() {
    const hospital = document.getElementById('dashHospital')?.value || '';
    const period   = document.getElementById('dashPeriod')?.value   || '';
    const dateFrom = document.getElementById('dashDateFrom')?.value || '';
    const dateTo   = document.getElementById('dashDateTo')?.value   || '';

    let reports = await DB.getReports();
    if (hospital) reports = reports.filter(r => r.hospital === hospital);
    if (period)   reports = reports.filter(r => r.period   === period);
    if (dateFrom) reports = reports.filter(r => r.date >= dateFrom);
    if (dateTo)   reports = reports.filter(r => r.date <= dateTo);

    const totals = reports.reduce((acc, r) => {
      acc.total     += +r.total     || 0;
      acc.present   += +r.present   || 0;
      acc.absent    += +r.absent    || 0;
      acc.withdrawn += +r.withdrawn || 0;
      acc.leave     += +r.leave     || 0;
      return acc;
    }, { total:0, present:0, absent:0, withdrawn:0, leave:0 });

    document.getElementById('stat-total').textContent     = totals.total;
    document.getElementById('stat-present').textContent   = totals.present;
    document.getElementById('stat-absent').textContent    = totals.absent;
    document.getElementById('stat-withdrawn').textContent = totals.withdrawn;
    document.getElementById('stat-leave').textContent     = totals.leave;
    document.getElementById('stat-reports').textContent   = reports.length;

    // ملخص التقارير
    const rSummary = document.getElementById('reportsSummaryTable');
    if (rSummary) {
      const approved = reports.filter(r => r.status === 'approved').length;
      const pending  = reports.filter(r => r.status === 'pending').length;
      const rejected = reports.filter(r => r.status === 'rejected').length;
      rSummary.innerHTML = `
        <table class="data-table">
          <thead><tr><th>الحالة</th><th>العدد</th></tr></thead>
          <tbody>
            <tr><td><span class="badge badge-success"><i class="fas fa-check"></i> معتمدة</span></td><td><strong>${approved}</strong></td></tr>
            <tr><td><span class="badge badge-pending"><i class="fas fa-clock"></i> بانتظار الاعتماد</span></td><td><strong>${pending}</strong></td></tr>
            <tr><td><span class="badge badge-danger"><i class="fas fa-times"></i> مرفوضة</span></td><td><strong>${rejected}</strong></td></tr>
            <tr><td><strong>الإجمالي</strong></td><td><strong>${reports.length}</strong></td></tr>
          </tbody>
        </table>`;
    }

    // توزيع حسب المستشفى
    const hSummary = document.getElementById('hospitalSummaryTable');
    if (hSummary) {
      const byHosp = {};
      DB.HOSPITALS.forEach(h => { byHosp[h] = { total:0, present:0, absent:0, reps:0 }; });
      reports.forEach(r => {
        if (byHosp[r.hospital]) {
          byHosp[r.hospital].reps++;
          byHosp[r.hospital].present   += +r.present   || 0;
          byHosp[r.hospital].absent    += +r.absent     || 0;
        }
      });
      hSummary.innerHTML = `
        <table class="data-table">
          <thead><tr><th>المستشفى</th><th>تقارير</th><th>حضور</th><th>غياب</th></tr></thead>
          <tbody>${DB.HOSPITALS.map(h => `
            <tr>
              <td style="font-size:12.5px">${h}</td>
              <td>${byHosp[h].reps}</td>
              <td>${byHosp[h].present}</td>
              <td>${byHosp[h].absent}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
    }

    // آخر 10 تقارير
    const latest = [...reports].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,10);
    const tbody = document.getElementById('latestReportsBody');
    if (tbody) {
      if (!latest.length) {
        tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><i class="fas fa-inbox"></i><p>لا توجد تقارير بعد</p></div></td></tr>`;
      } else {
        tbody.innerHTML = latest.map(r => `
          <tr>
            <td>${r.date}</td>
            <td>${r.hospital || '-'}</td>
            <td>${r.department || '-'}</td>
            <td>${r.period || '-'}</td>
            <td>${r.present || 0}</td>
            <td>${r.absent || 0}</td>
            <td>${r.withdrawn || 0}</td>
            <td>${r.enteredBy || '-'}</td>
            <td>${this._statusBadge(r.status)}</td>
          </tr>`).join('');
      }
    }
  },

  resetDashFilter() {
    ['dashHospital','dashPeriod','dashDateFrom','dashDateTo'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    this.loadDashboard();
  },

  /* ====== موظفون ====== */
  async renderEmployees() {
    const search = (document.getElementById('empSearchInput')?.value || '').toLowerCase();
    let emps = await DB.getEmployees();
    if (search) emps = emps.filter(e => e.name.toLowerCase().includes(search) || e.code.toLowerCase().includes(search));
    const tbody = document.getElementById('employeesBody');
    if (!tbody) return;
    if (!emps.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fas fa-id-card"></i><p>${search ? 'لا توجد نتائج' : 'لم يتم إضافة موظفين بعد'}</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = emps.map((e, i) => `
      <tr>
        <td>${i+1}</td>
        <td><strong>${e.name}</strong></td>
        <td><code style="background:#f0f4f8;padding:3px 10px;border-radius:6px;font-size:13px;letter-spacing:1px">${e.code}</code></td>
        <td>${e.hospital || '<span class="text-muted">—</span>'}</td>
        <td>${e.department || '<span class="text-muted">—</span>'}</td>
        <td style="font-size:13px;color:var(--text-muted)">${DB.formatDate(e.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-outline btn-sm btn-icon" title="تعديل" onclick="AdminApp.editEmployee('${e.id}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" title="حذف" onclick="AdminApp.deleteEmployee('${e.id}','${e.name}')"><i class="fas fa-trash"></i></button>
        </div></td>
      </tr>`).join('');
  },

  async openEmpModal(emp) {
    document.getElementById('empEditId').value = emp?.id || '';
    document.getElementById('empName').value = emp?.name || '';
    document.getElementById('empCode').value = emp?.code || '';
    document.getElementById('empHospital').value = emp?.hospital || '';
    await this.loadDeptOptions('empDept','empHospital', emp?.department);
    document.getElementById('empModalTitle').textContent = emp ? 'تعديل بيانات الموظف' : 'إضافة موظف جديد';
    this.openModal('empModal');
  },

  async editEmployee(id) {
    const emps = await DB.getEmployees();
    const emp = emps.find(e => e.id === id);
    if (emp) await this.openEmpModal(emp);
  },

  async saveEmployee() {
    const id   = document.getElementById('empEditId').value;
    const name = document.getElementById('empName').value.trim();
    const code = document.getElementById('empCode').value.trim().toUpperCase();
    const hospital = document.getElementById('empHospital').value;
    const department = document.getElementById('empDept').value;

    if (!name) return Toast.show('يرجى إدخال اسم الموظف', 'error');
    if (!code) return Toast.show('يرجى إدخال الكود الخاص', 'error');
    if (!/^[A-Z0-9\-_]+$/i.test(code)) return Toast.show('الكود يجب أن يحتوي على حروف وأرقام فقط', 'error');

    const result = id
      ? await DB.updateEmployee(id, { name, code, hospital, department })
      : await DB.addEmployee({ name, code, hospital, department });

    if (!result.ok) return Toast.show(result.msg, 'error');
    Toast.show(id ? 'تم تحديث بيانات الموظف' : 'تمت إضافة الموظف بنجاح', 'success');
    this.closeModal('empModal');
    await this.renderEmployees();
  },

  deleteEmployee(id, name) {
    this._confirm(`هل تريد حذف الموظف "${name}"؟`, async () => {
      await DB.deleteEmployee(id);
      Toast.show('تم حذف الموظف', 'success');
      await this.renderEmployees();
    });
  },

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'EMP';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById('empCode').value = code;
  },

  /* ====== جداول الدوام ====== */
  async renderShifts() {
    const shifts = await DB.getShifts();
    const tbody = document.getElementById('shiftsBody');
    if (!tbody) return;
    if (!shifts.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fas fa-calendar-alt"></i><p>لم يتم إضافة جداول دوام بعد</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = shifts.map((s, i) => `
      <tr>
        <td>${i+1}</td>
        <td>${s.hospital}</td>
        <td>${s.department}</td>
        <td><span class="badge badge-info">${s.period}</span></td>
        <td><strong>${s.requiredCount}</strong> موظف</td>
        <td style="font-size:13px;color:var(--text-muted)">${DB.formatDate(s.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-outline btn-sm btn-icon" title="تعديل" onclick="AdminApp.editShift('${s.id}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" title="حذف" onclick="AdminApp.deleteShift('${s.id}')"><i class="fas fa-trash"></i></button>
        </div></td>
      </tr>`).join('');
  },

  async openShiftModal(shift) {
    document.getElementById('shiftEditId').value = shift?.id || '';
    document.getElementById('shiftHospital').value  = shift?.hospital || '';
    document.getElementById('shiftPeriod').value    = shift?.period   || '';
    document.getElementById('shiftCount').value     = shift?.requiredCount || '';
    await this.loadDeptOptions('shiftDept','shiftHospital', shift?.department);
    document.getElementById('shiftModalTitle').textContent = shift ? 'تعديل جدول الدوام' : 'إضافة جدول دوام';
    this.openModal('shiftModal');
  },

  async editShift(id) {
    const shifts = await DB.getShifts();
    const s = shifts.find(x => x.id === id);
    if (s) await this.openShiftModal(s);
  },

  async saveShift() {
    const id       = document.getElementById('shiftEditId').value;
    const hospital = document.getElementById('shiftHospital').value;
    const dept     = document.getElementById('shiftDept').value;
    const period   = document.getElementById('shiftPeriod').value;
    const count    = +document.getElementById('shiftCount').value;

    if (!hospital) return Toast.show('يرجى اختيار المستشفى', 'error');
    if (!dept)     return Toast.show('يرجى اختيار القسم', 'error');
    if (!period)   return Toast.show('يرجى اختيار الفترة', 'error');
    if (!count || count < 1) return Toast.show('يرجى إدخال عدد الموظفين', 'error');

    const data = { hospital, department: dept, period, requiredCount: count };
    if (id) await DB.updateShift(id, data);
    else    await DB.addShift(data);

    Toast.show(id ? 'تم تحديث جدول الدوام' : 'تمت إضافة جدول الدوام', 'success');
    this.closeModal('shiftModal');
    await this.renderShifts();
  },

  deleteShift(id) {
    this._confirm('هل تريد حذف هذا الجدول؟', async () => {
      await DB.deleteShift(id);
      Toast.show('تم حذف الجدول', 'success');
      await this.renderShifts();
    });
  },

  /* ====== أقسام ====== */
  async renderDepts() {
    const depts = await DB.getDepartments();
    const tbody = document.getElementById('deptsBody');
    if (!tbody) return;
    if (!depts.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><i class="fas fa-sitemap"></i><p>لم يتم إضافة أقسام بعد</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = depts.map((d, i) => `
      <tr>
        <td>${i+1}</td>
        <td><strong>${d.name}</strong></td>
        <td>${d.hospital}</td>
        <td style="font-size:13px;color:var(--text-muted)">${DB.formatDate(d.createdAt)}</td>
        <td><button class="btn btn-danger btn-sm btn-icon" onclick="AdminApp.deleteDept('${d.id}','${d.name}')"><i class="fas fa-trash"></i></button></td>
      </tr>`).join('');
  },

  openDeptModal() { this.openModal('deptModal'); document.getElementById('deptName').value = ''; document.getElementById('deptHospital').value = ''; },

  async saveDept() {
    const name = document.getElementById('deptName').value.trim();
    const hospital = document.getElementById('deptHospital').value;
    if (!name) return Toast.show('يرجى إدخال اسم القسم', 'error');
    if (!hospital) return Toast.show('يرجى اختيار المستشفى', 'error');
    await DB.addDepartment({ name, hospital });
    Toast.show('تمت إضافة القسم بنجاح', 'success');
    this.closeModal('deptModal');
    await this.renderDepts();
  },

  deleteDept(id, name) {
    this._confirm(`هل تريد حذف قسم "${name}"؟`, async () => {
      await DB.deleteDepartment(id);
      Toast.show('تم حذف القسم', 'success');
      await this.renderDepts();
    });
  },

  /* ====== تحميل خيارات الأقسام ====== */
  async loadDeptOptions(targetId, hospitalSelectId, selected) {
    const hospital = document.getElementById(hospitalSelectId)?.value;
    const select = document.getElementById(targetId);
    if (!select) return;
    select.innerHTML = '<option value="">-- اختر القسم --</option>';
    if (hospital) {
      const depts = await DB.getDeptsByHospital(hospital);
      depts.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name; opt.textContent = d.name;
        if (selected && d.name === selected) opt.selected = true;
        select.appendChild(opt);
      });
    }
  },

  /* ====== سجل التقارير ====== */
  async renderReports() {
    const filterDate    = document.getElementById('repFilterDate')?.value    || '';
    const filterHosp    = document.getElementById('repFilterHospital')?.value || '';
    const filterPeriod  = document.getElementById('repFilterPeriod')?.value  || '';
    const filterStatus  = document.getElementById('repFilterStatus')?.value  || '';
    const filterSearch  = (document.getElementById('repFilterSearch')?.value || '').toLowerCase();

    let reports = await DB.getReports();
    if (filterDate)   reports = reports.filter(r => r.date === filterDate);
    if (filterHosp)   reports = reports.filter(r => r.hospital === filterHosp);
    if (filterPeriod) reports = reports.filter(r => r.period   === filterPeriod);
    if (filterStatus) reports = reports.filter(r => r.status   === filterStatus);
    if (filterSearch) reports = reports.filter(r =>
      (r.enteredBy || '').toLowerCase().includes(filterSearch) ||
      (r.department || '').toLowerCase().includes(filterSearch) ||
      (r.absentNames || '').toLowerCase().includes(filterSearch)
    );
    reports = [...reports].sort((a,b) => b.createdAt.localeCompare(a.createdAt));

    const countEl = document.getElementById('reportsCount');
    if (countEl) countEl.textContent = `(${reports.length} تقرير)`;

    const tbody = document.getElementById('reportsBody');
    if (!tbody) return;
    if (!reports.length) {
      tbody.innerHTML = `<tr><td colspan="14"><div class="empty-state"><i class="fas fa-clipboard-list"></i><p>لا توجد تقارير</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = reports.map((r, i) => `
      <tr>
        <td>${i+1}</td>
        <td>${r.date}</td>
        <td>${r.day || DB.getDayName(r.date)}</td>
        <td style="font-size:13px">${r.hospital || '-'}</td>
        <td>${r.department || '-'}</td>
        <td><span class="badge badge-info">${r.period || '-'}</span></td>
        <td>${r.total || 0}</td>
        <td><span style="color:var(--success);font-weight:700">${r.present || 0}</span></td>
        <td><span style="color:var(--danger);font-weight:700">${r.absent || 0}</span></td>
        <td>${r.withdrawn || 0}</td>
        <td>${r.leave || 0}</td>
        <td>${r.enteredBy || '-'}</td>
        <td>${this._statusBadge(r.status)}</td>
        <td>
          <div class="actions">
            <button class="btn btn-outline btn-sm btn-icon" title="تفاصيل" onclick="AdminApp.viewReport('${r.id}')"><i class="fas fa-eye"></i></button>
            ${r.status === 'pending' ? `
              <button class="btn btn-success btn-sm btn-icon" title="اعتماد" onclick="AdminApp.approveReport('${r.id}')"><i class="fas fa-check"></i></button>
              <button class="btn btn-danger btn-sm btn-icon" title="رفض" onclick="AdminApp.openRejectModal('${r.id}')"><i class="fas fa-times"></i></button>` : ''}
            <button class="btn btn-danger btn-sm btn-icon" title="حذف" onclick="AdminApp.deleteReport('${r.id}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`).join('');

    await this._updatePendingBadge();
  },

  resetRepFilter() {
    ['repFilterDate','repFilterHospital','repFilterPeriod','repFilterStatus','repFilterSearch'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    this.renderReports();
  },

  async approveReport(id) {
    if (await DB.approveReport(id)) {
      Toast.show('تم اعتماد التقرير بنجاح', 'success');
      await this.renderReports();
      await this._updatePendingBadge();
    }
  },

  openRejectModal(id) {
    document.getElementById('rejectReportId').value = id;
    document.getElementById('rejectReason').value = '';
    this.openModal('rejectModal');
  },

  async confirmReject() {
    const id = document.getElementById('rejectReportId').value;
    const reason = document.getElementById('rejectReason').value.trim();
    if (!reason) return Toast.show('يرجى كتابة سبب الرفض', 'error');
    await DB.rejectReport(id, reason);
    Toast.show('تم رفض التقرير', 'warning');
    this.closeModal('rejectModal');
    await this.renderReports();
    await this._updatePendingBadge();
  },

  async viewReport(id) {
    const reports = await DB.getReports();
    const r = reports.find(x => x.id === id);
    if (!r) return;
    const body = document.getElementById('reportDetailBody');
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        ${this._detailRow('التاريخ', r.date)}
        ${this._detailRow('اليوم', r.day || DB.getDayName(r.date))}
        ${this._detailRow('الفترة', `<span class="badge badge-info">${r.period||'-'}</span>`)}
        ${this._detailRow('المستشفى', r.hospital||'-')}
        ${this._detailRow('القسم', r.department||'-')}
        ${this._detailRow('الحالة', this._statusBadge(r.status))}
        ${this._detailRow('إجمالي الموظفين', `<strong>${r.total||0}</strong>`)}
        ${this._detailRow('الحضور', `<span style="color:var(--success);font-weight:700">${r.present||0}</span>`)}
        ${this._detailRow('الغياب', `<span style="color:var(--danger);font-weight:700">${r.absent||0}</span>`)}
        ${this._detailRow('الانسحاب', r.withdrawn||0)}
        ${this._detailRow('في إجازة', r.leave||0)}
        ${this._detailRow('مدخل البيانات', r.enteredBy||'-')}
      </div>
      ${r.absentNames ? `<div style="margin-top:16px"><strong>أسماء المتغيبين:</strong><div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-top:8px;white-space:pre-wrap;font-size:14px">${r.absentNames}</div></div>` : ''}
      ${r.notes ? `<div style="margin-top:16px"><strong>الملاحظات:</strong><div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-top:8px;white-space:pre-wrap;font-size:14px">${r.notes}</div></div>` : ''}
      ${r.status==='rejected' && r.rejectionReason ? `<div style="margin-top:16px;background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:8px;padding:14px"><strong style="color:var(--danger)"><i class="fas fa-ban"></i> سبب الرفض:</strong><p style="margin-top:6px;font-size:14px">${r.rejectionReason}</p></div>` : ''}
      ${r.status === 'pending' ? `
        <div style="margin-top:20px;display:flex;gap:10px;justify-content:center">
          <button class="btn btn-success" onclick="AdminApp.approveReport('${r.id}');AdminApp.closeModal('reportDetailModal')"><i class="fas fa-check"></i> اعتماد</button>
          <button class="btn btn-danger" onclick="AdminApp.closeModal('reportDetailModal');AdminApp.openRejectModal('${r.id}')"><i class="fas fa-ban"></i> رفض</button>
        </div>` : ''}
      <p style="margin-top:16px;font-size:12px;color:var(--text-muted);text-align:left">
        تاريخ الإدخال: ${DB.formatDate(r.createdAt)}
        ${r.approvedAt ? '| تاريخ الاعتماد: ' + DB.formatDate(r.approvedAt) : ''}
        ${r.rejectedAt ? '| تاريخ الرفض: '   + DB.formatDate(r.rejectedAt)  : ''}
      </p>`;
    this.openModal('reportDetailModal');
  },

  _detailRow(label, val) {
    return `<div style="background:var(--surface-2);border-radius:8px;padding:12px 14px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${label}</div>
      <div style="font-size:14px;font-weight:600">${val}</div>
    </div>`;
  },

  deleteReport(id) {
    this._confirm('هل تريد حذف هذا التقرير نهائياً؟', async () => {
      await DB.deleteReport(id);
      Toast.show('تم حذف التقرير', 'success');
      await this.renderReports();
      await this._updatePendingBadge();
    });
  },

  clearReports() {
    this._confirm('سيتم حذف جميع التقارير نهائياً. هل أنت متأكد؟', async () => {
      await DB.clearReports();
      Toast.show('تم حذف جميع التقارير', 'success');
      await this._updatePendingBadge();
    });
  },

  /* ====== التقارير الدورية ====== */
  _buildReportTable(reports) {
    if (!reports.length) return `<div class="empty-state" style="padding:40px"><i class="fas fa-inbox"></i><p>لا توجد تقارير في هذه الفترة</p></div>`;
    const totals = reports.reduce((a,r) => {
      a.total+=+r.total||0; a.present+=+r.present||0; a.absent+=+r.absent||0;
      a.withdrawn+=+r.withdrawn||0; a.leave+=+r.leave||0; return a;
    }, {total:0,present:0,absent:0,withdrawn:0,leave:0});
    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;padding:16px;background:var(--surface-2);border-bottom:1px solid var(--border)">
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--secondary)">${totals.total}</div><div style="font-size:12px;color:var(--text-muted)">إجمالي الموظفين</div></div>
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--success)">${totals.present}</div><div style="font-size:12px;color:var(--text-muted)">الحضور</div></div>
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--danger)">${totals.absent}</div><div style="font-size:12px;color:var(--text-muted)">الغياب</div></div>
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--warning)">${totals.withdrawn}</div><div style="font-size:12px;color:var(--text-muted)">الانسحاب</div></div>
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--pending)">${totals.leave}</div><div style="font-size:12px;color:var(--text-muted)">الإجازات</div></div>
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--text)">${reports.length}</div><div style="font-size:12px;color:var(--text-muted)">تقرير</div></div>
      </div>
      <div class="table-overflow">
        <table class="data-table">
          <thead><tr>
            <th>#</th><th>التاريخ</th><th>اليوم</th><th>المستشفى</th><th>القسم</th><th>الفترة</th>
            <th>إجمالي</th><th>حضور</th><th>غياب</th><th>انسحاب</th><th>إجازة</th>
            <th>الغائبون</th><th>ملاحظات</th><th>مدخل البيانات</th><th>الحالة</th>
          </tr></thead>
          <tbody>${reports.map((r,i) => `
            <tr>
              <td>${i+1}</td>
              <td>${r.date}</td>
              <td>${r.day||DB.getDayName(r.date)}</td>
              <td style="font-size:12.5px">${r.hospital||'-'}</td>
              <td>${r.department||'-'}</td>
              <td><span class="badge badge-info" style="font-size:11px">${r.period||'-'}</span></td>
              <td>${r.total||0}</td>
              <td><span style="color:var(--success);font-weight:700">${r.present||0}</span></td>
              <td><span style="color:var(--danger);font-weight:700">${r.absent||0}</span></td>
              <td>${r.withdrawn||0}</td>
              <td>${r.leave||0}</td>
              <td style="font-size:12px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${r.absentNames||''}">${r.absentNames||'-'}</td>
              <td style="font-size:12px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${r.notes||''}">${r.notes||'-'}</td>
              <td>${r.enteredBy||'-'}</td>
              <td>${this._statusBadge(r.status)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  },

  async renderDailyReport() {
    const date = document.getElementById('dailyDate')?.value;
    const body = document.getElementById('dailyReportBody');
    if (!body) return;
    const reports = (await DB.getReports()).filter(r => r.date === date);
    body.innerHTML = this._buildReportTable(reports);
  },

  async renderWeeklyReport() {
    const from = document.getElementById('weeklyFrom')?.value;
    const to   = document.getElementById('weeklyTo')?.value;
    const body = document.getElementById('weeklyReportBody');
    if (!body) return;
    const reports = (await DB.getReports()).filter(r => (!from || r.date >= from) && (!to || r.date <= to));
    body.innerHTML = this._buildReportTable(reports);
  },

  async renderMonthlyReport() {
    const month = document.getElementById('monthlyMonth')?.value;
    const body = document.getElementById('monthlyReportBody');
    if (!body) return;
    const reports = (await DB.getReports()).filter(r => month && r.date.startsWith(month));
    body.innerHTML = this._buildReportTable(reports);
  },

  /* ====== تصدير Excel ====== */
  async exportReports(type) {
    let reports = await DB.getReports();
    let filename = 'تقرير_الدوام';

    if (type === 'daily') {
      const date = document.getElementById('dailyDate')?.value;
      reports = reports.filter(r => r.date === date);
      filename = `تقرير_يومي_${date}`;
    } else if (type === 'weekly') {
      const from = document.getElementById('weeklyFrom')?.value;
      const to   = document.getElementById('weeklyTo')?.value;
      reports = reports.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
      filename = `تقرير_اسبوعي_${from}_${to}`;
    } else if (type === 'monthly') {
      const month = document.getElementById('monthlyMonth')?.value;
      reports = reports.filter(r => month && r.date.startsWith(month));
      filename = `تقرير_شهري_${month}`;
    } else {
      // apply current filters
      const fd = document.getElementById('repFilterDate')?.value    || '';
      const fh = document.getElementById('repFilterHospital')?.value || '';
      const fp = document.getElementById('repFilterPeriod')?.value  || '';
      const fs = document.getElementById('repFilterStatus')?.value  || '';
      if (fd) reports = reports.filter(r => r.date === fd);
      if (fh) reports = reports.filter(r => r.hospital === fh);
      if (fp) reports = reports.filter(r => r.period   === fp);
      if (fs) reports = reports.filter(r => r.status   === fs);
      filename = `سجل_التقارير`;
    }

    if (!reports.length) return Toast.show('لا توجد بيانات للتصدير', 'warning');

    const statusMap = { pending: 'بانتظار الاعتماد', approved: 'معتمد', rejected: 'مرفوض' };
    const rows = reports.map((r, i) => ({
      '#': i + 1,
      'التاريخ': r.date,
      'اليوم': r.day || DB.getDayName(r.date),
      'المستشفى': r.hospital || '',
      'القسم': r.department || '',
      'الفترة': r.period || '',
      'إجمالي الموظفين': r.total || 0,
      'الحضور': r.present || 0,
      'الغياب': r.absent || 0,
      'الانسحاب': r.withdrawn || 0,
      'الإجازات': r.leave || 0,
      'أسماء المتغيبين': r.absentNames || '',
      'الملاحظات': r.notes || '',
      'مدخل البيانات': r.enteredBy || '',
      'الحالة': statusMap[r.status] || r.status,
      'سبب الرفض': r.rejectionReason || '',
    }));

    if (typeof XLSX !== 'undefined') {
      const ws = XLSX.utils.json_to_sheet(rows, { skipHeader: false });
      ws['!cols'] = Object.keys(rows[0]).map((k, i) => ({ wch: [4,12,10,22,18,10,16,10,10,10,10,30,30,20,16,30][i] || 14 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'التقارير');
      XLSX.writeFile(wb, `${filename}.xlsx`);
      Toast.show('تم تصدير ملف Excel بنجاح', 'success');
    } else {
      // Fallback: CSV
      const headers = Object.keys(rows[0]);
      const csv = '﻿' + [headers, ...rows.map(r => headers.map(h => `"${(r[h]||'').toString().replace(/"/g,'""')}"`))].map(r => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a'); a.href = url; a.download = `${filename}.csv`; a.click();
      URL.revokeObjectURL(url);
      Toast.show('تم تصدير ملف CSV', 'success');
    }
  },

  /* ====== الإعدادات ====== */
  async changePassword() {
    const oldP = document.getElementById('settingsOldPass').value;
    const newP = document.getElementById('settingsNewPass').value;
    const conP = document.getElementById('settingsConfPass').value;
    const currentPass = await DB.getPass();
    if (oldP !== currentPass) return Toast.show('كلمة المرور الحالية غير صحيحة', 'error');
    if (newP.length < 6) return Toast.show('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل', 'error');
    if (newP !== conP) return Toast.show('كلمتا المرور غير متطابقتين', 'error');
    await DB.setPass(newP);
    Toast.show('تم تغيير كلمة المرور بنجاح', 'success');
    ['settingsOldPass','settingsNewPass','settingsConfPass'].forEach(id => { document.getElementById(id).value = ''; });
  },

  /* ====== مودال ====== */
  openModal(id) {
    const m = document.getElementById(id);
    if (m) { m.classList.add('open'); document.body.style.overflow = 'hidden'; }
  },
  closeModal(id) {
    const m = document.getElementById(id);
    if (m) { m.classList.remove('open'); document.body.style.overflow = ''; }
  },

  /* ====== تأكيد الحذف ====== */
  _confirm(msg, cb) {
    document.getElementById('confirmMsg').textContent = msg;
    const btn = document.getElementById('confirmBtn');
    btn.onclick = () => { cb(); this.closeModal('confirmModal'); };
    this.openModal('confirmModal');
  },

  /* ====== مساعدات ====== */
  _statusBadge(status) {
    const map = {
      pending:  `<span class="badge badge-pending"><i class="fas fa-clock"></i> بانتظار الاعتماد</span>`,
      approved: `<span class="badge badge-success"><i class="fas fa-check-circle"></i> معتمد</span>`,
      rejected: `<span class="badge badge-danger"><i class="fas fa-ban"></i> مرفوض</span>`,
    };
    return map[status] || `<span class="badge badge-primary">${status}</span>`;
  },
};

/* ======================================================
   بوابة الموظف
   ====================================================== */
const EmployeeApp = {
  currentEmployee: null,

  init() {
    // إغلاق modal بالضغط خارجه
    document.querySelectorAll('.modal-overlay').forEach(m => {
      m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
    });

    const emp = DB.getEmpSession();
    if (emp) {
      this.currentEmployee = emp;
      this._showForm();
    }

    const inp = document.getElementById('empCodeInput');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });

    const dateEl = document.getElementById('repDate');
    if (dateEl) {
      dateEl.value = DB.today();
      dateEl.addEventListener('change', () => {
        const dayEl = document.getElementById('repDay');
        if (dayEl) dayEl.value = DB.getDayName(dateEl.value);
      });
      document.getElementById('repDay').value = DB.getDayName(dateEl.value);
    }
  },

  async login() {
    const code = document.getElementById('empCodeInput').value.trim().toUpperCase();
    const err  = document.getElementById('empLoginError');
    const emp  = await DB.findByCode(code);
    if (emp) {
      err.classList.remove('show');
      this.currentEmployee = emp;
      DB.setEmpSession(emp);
      this._showForm();
    } else {
      err.classList.add('show');
    }
  },

  logout() {
    DB.clearEmpSession();
    this.currentEmployee = null;
    document.getElementById('empLoginView').style.display = '';
    document.getElementById('empFormView').style.display = 'none';
    document.getElementById('empCodeInput').value = '';
  },

  _showForm() {
    document.getElementById('empLoginView').style.display = 'none';
    document.getElementById('empFormView').style.display = '';
    document.getElementById('empDisplayName').textContent = this.currentEmployee.name;
    document.getElementById('repEnteredBy').value = this.currentEmployee.name;
    document.getElementById('empSuccessMsg').style.display = 'none';
    document.getElementById('empMainForm').style.display = '';

    const dateEl = document.getElementById('repDate');
    if (dateEl && !dateEl.value) {
      dateEl.value = DB.today();
      document.getElementById('repDay').value = DB.getDayName(dateEl.value);
    }
  },

  loadDepts() {
    const hospital = document.getElementById('repHospital').value;
    const select = document.getElementById('repDept');
    select.innerHTML = '<option value="">-- اختر القسم --</option>';
    if (hospital) {
      const depts = DB.DEFAULT_DEPARTMENTS[hospital] || [];
      depts.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        select.appendChild(opt);
      });
    }
  },

  recalculate() {
    const total     = +document.getElementById('repTotal').value     || 0;
    const present   = +document.getElementById('repPresent').value   || 0;
    const absent    = +document.getElementById('repAbsent').value    || 0;
    const withdrawn = +document.getElementById('repWithdrawn').value || 0;
    const leave     = +document.getElementById('repLeave').value     || 0;
    const sum = present + absent + withdrawn + leave;
    const el = document.getElementById('numValidation');
    if (!el) return;
    if (total === 0) { el.style.display = 'none'; return; }
    if (sum > total) {
      el.style.display = 'block';
      el.style.background = 'var(--danger-bg)'; el.style.color = 'var(--danger)'; el.style.border = '1px solid var(--danger-border)';
      el.innerHTML = `<i class="fas fa-exclamation-triangle"></i> مجموع الأرقام (${sum}) أكبر من إجمالي الموظفين (${total})`;
    } else if (sum === total) {
      el.style.display = 'block';
      el.style.background = 'var(--success-bg)'; el.style.color = 'var(--success)'; el.style.border = '1px solid var(--success-border)';
      el.innerHTML = `<i class="fas fa-check-circle"></i> الأرقام صحيحة — المجموع: ${sum}`;
    } else {
      el.style.display = 'block';
      el.style.background = 'var(--warning-bg)'; el.style.color = 'var(--warning)'; el.style.border = '1px solid var(--warning-border)';
      el.innerHTML = `<i class="fas fa-info-circle"></i> المجموع الحالي: ${sum} من ${total}`;
    }
  },

  async submitReport() {
    const date      = document.getElementById('repDate').value;
    const day       = document.getElementById('repDay').value;
    const period    = document.getElementById('repPeriod').value;
    const hospital  = document.getElementById('repHospital').value;
    const dept      = document.getElementById('repDept').value;
    const total     = +document.getElementById('repTotal').value     || 0;
    const present   = +document.getElementById('repPresent').value   || 0;
    const absent    = +document.getElementById('repAbsent').value    || 0;
    const withdrawn = +document.getElementById('repWithdrawn').value || 0;
    const leave     = +document.getElementById('repLeave').value     || 0;
    const absentNames = document.getElementById('repAbsentNames').value.trim();
    const notes     = document.getElementById('repNotes').value.trim();
    const enteredBy = document.getElementById('repEnteredBy').value;

    // تحقق
    if (!date)    return Toast.show('يرجى اختيار التاريخ', 'error');
    if (!period)  return Toast.show('يرجى اختيار الفترة', 'error');
    if (!hospital) return Toast.show('يرجى اختيار المستشفى', 'error');
    if (!dept)    return Toast.show('يرجى اختيار القسم', 'error');
    if (total < 0) return Toast.show('إجمالي الموظفين لا يمكن أن يكون سالباً', 'error');

    const sum = present + absent + withdrawn + leave;
    if (sum > total && total > 0) return Toast.show(`مجموع الأرقام (${sum}) أكبر من إجمالي الموظفين (${total})`, 'error');

    const saved = await DB.addReport({ date, day, period, hospital, department: dept, total, present, absent, withdrawn, leave, absentNames, notes, enteredBy, employeeCode: this.currentEmployee.code });
    if (!saved) return Toast.show('تعذّر حفظ التقرير — تحقق من الاتصال', 'error');

    // إخفاء النموذج وعرض رسالة النجاح
    document.getElementById('empMainForm').style.display = 'none';
    document.getElementById('empSuccessMsg').style.display = 'block';
    document.getElementById('numValidation').style.display = 'none';
  },

  newReport() {
    document.getElementById('empMainForm').style.display = '';
    document.getElementById('empSuccessMsg').style.display = 'none';
    // إعادة ضبط الحقول
    ['repPeriod','repHospital','repDept'].forEach(id => { document.getElementById(id).value = ''; });
    ['repTotal','repPresent','repAbsent','repWithdrawn','repLeave'].forEach(id => { document.getElementById(id).value = 0; });
    document.getElementById('repAbsentNames').value = '';
    document.getElementById('repNotes').value = '';
    document.getElementById('repDate').value = DB.today();
    document.getElementById('repDay').value = DB.getDayName(DB.today());
    document.getElementById('numValidation').style.display = 'none';
  },
};

/* ======================================================
   تهيئة عند تحميل الصفحة
   ====================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;

  // إغلاق المودالات بالضغط خارجها
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) m.classList.remove('open');
    });
  });

  if (page === 'admin')    AdminApp.init();
  if (page === 'employee') EmployeeApp.init();
});
