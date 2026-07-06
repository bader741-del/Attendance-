/* ============================================================
   منصة مراقبة الدوام - مدينة الملك سلمان الطبية
   script.js - المنطق البرمجي الكامل
   ============================================================ */

'use strict';

/* ======================================================
   تهريب المدخلات — حماية من XSS المخزَّن
   ====================================================== */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ======================================================
   طبقة قاعدة البيانات (LocalStorage)
   ====================================================== */
const DB = {
  _k: {
    pass:    'mksh_admin_pass',
    emps:    'mksh_employees',
    depts:   'mksh_departments',
    shifts:  'mksh_shifts',
    reports: 'mksh_reports',
    session: 'mksh_admin_session',
    empSess: 'mksh_emp_session',
    audit:   'mksh_audit',
    settings:'mksh_settings',
    theme:   'mksh_theme',
    sigs:    'mksh_signatures',
  },

  HOSPITALS: [
    'مستشفى الطب النفسي',
    'مستشفى النساء والأطفال',
    'مستشفى المدينة الرئيسي',
  ],

  DAYS: ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'],

  _get(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch { return def; }
  },
  _set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch(e) {
      console.error(e);
      // إبلاغ المستخدم بدل الفشل الصامت (مثل امتلاء مساحة التخزين)
      if (typeof Toast !== 'undefined') Toast.show('تعذر حفظ البيانات — مساحة تخزين المتصفح ممتلئة. نزّل نسخة احتياطية ثم احذف تقارير قديمة.', 'error', 6000);
    }
  },

  /* ---- كلمة مرور المسؤول (مشفرة SHA-256) ---- */
  getPass()       { return this._get(this._k.pass, 'admin1234'); },
  setPass(p)      { this._set(this._k.pass, p); },

  async hash(str) {
    if (window.crypto?.subtle && window.isSecureContext !== false) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // بديل بسيط في حال عدم توفر Web Crypto
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return 'f' + h1.toString(16) + h2.toString(16);
  },
  async setPassHashed(p) { this._set(this._k.pass, 'sha256:' + await this.hash(p)); },
  async verifyPass(input) {
    const stored = this.getPass();
    if (typeof stored === 'string' && stored.startsWith('sha256:')) {
      return ('sha256:' + await this.hash(input)) === stored;
    }
    // نسخة قديمة (نص واضح) — ترحيل تلقائي إلى نسخة مشفرة عند أول دخول ناجح
    if (input === stored) { await this.setPassHashed(input); return true; }
    return false;
  },

  /* ---- الإعدادات العامة (النائب الإداري / التوقيع) ---- */
  getSettings()      { return this._get(this._k.settings, {}); },
  saveSettings(patch){ this._set(this._k.settings, { ...this.getSettings(), ...patch }); },

  /* ---- سجل التوقيعات المرجعي (توقيع واحد محفوظ مرة واحدة، والتقارير تشير إليه بمعرّف) ---- */
  getSignaturesReg() { return this._get(this._k.sigs, {}); },
  addSignatureToReg(dataURL) {
    if (!dataURL) return null;
    const reg = this.getSignaturesReg();
    // إن كان التوقيع نفسه محفوظاً مسبقاً أعد معرّفه (منع التكرار)
    for (const [id, v] of Object.entries(reg)) { if (v === dataURL) return id; }
    const id = this._uid();
    reg[id] = dataURL;
    this._set(this._k.sigs, reg);
    return id;
  },
  /* يدعم التقارير القديمة (توقيع مضمّن) والجديدة (معرّف مرجعي) */
  resolveSignature(r) {
    if (!r) return null;
    return r.signature || (r.sigId ? this.getSignaturesReg()[r.sigId] : null) || null;
  },
  /* ترحيل التقارير القديمة: نقل التوقيعات المضمّنة إلى السجل المرجعي (يعمل مرة واحدة) */
  migrateSignatures() {
    const reports = this.getReports();
    let changed = false;
    reports.forEach(r => {
      if (r.signature && r.signature.startsWith('data:')) {
        r.sigId = this.addSignatureToReg(r.signature);
        delete r.signature;
        changed = true;
      }
    });
    if (changed) this._saveReports(reports);
  },

  /* ---- سجل التدقيق ---- */
  getAudit() { return this._get(this._k.audit, []); },
  audit(action, details = '') {
    const log = this.getAudit();
    log.unshift({ id: this._uid(), at: this._now(), action, details });
    if (log.length > 600) log.length = 600;
    this._set(this._k.audit, log);
    // نسخة سحابية غير قابلة للمسح — من صفحة المسؤول فقط (تدقيق الموظف يُسجَّل من الخادم عبر RPC)
    if (document.body?.dataset?.page === 'admin') Sync.queueAudit(action, details);
  },
  clearAudit() { this._set(this._k.audit, []); },

  /* ---- جلسات ---- */
  setAdminSession()   { sessionStorage.setItem(this._k.session, '1'); },
  clearAdminSession() { sessionStorage.removeItem(this._k.session); },
  isAdminLoggedIn()   { return sessionStorage.getItem(this._k.session) === '1'; },

  setEmpSession(emp)   { sessionStorage.setItem(this._k.empSess, JSON.stringify(emp)); },
  clearEmpSession()    { sessionStorage.removeItem(this._k.empSess); },
  getEmpSession()      { try { const v = sessionStorage.getItem(this._k.empSess); return v ? JSON.parse(v) : null; } catch { return null; } },

  /* ---- موظفون ---- */
  getEmployees()   { return this._get(this._k.emps, []); },
  _saveEmps(arr)   { this._set(this._k.emps, arr); },
  addEmployee(data) {
    const emps = this.getEmployees();
    if (emps.some(e => e.code === data.code)) return { ok: false, msg: 'الكود مستخدم بالفعل' };
    emps.push({ ...data, id: this._uid(), createdAt: this._now() });
    this._saveEmps(emps);
    this.audit('إضافة موظف', `${data.name} (${data.code})`);
    Sync.up('employees', emps[emps.length - 1]);
    return { ok: true };
  },
  updateEmployee(id, data) {
    const emps = this.getEmployees();
    if (emps.some(e => e.code === data.code && e.id !== id)) return { ok: false, msg: 'الكود مستخدم بالفعل' };
    const idx = emps.findIndex(e => e.id === id);
    if (idx < 0) return { ok: false, msg: 'الموظف غير موجود' };
    emps[idx] = { ...emps[idx], ...data };
    this._saveEmps(emps);
    this.audit('تعديل موظف', `${data.name} (${data.code})`);
    Sync.up('employees', emps[idx]);
    return { ok: true };
  },
  deleteEmployee(id)   {
    const emp = this.getEmployees().find(e => e.id === id);
    this._saveEmps(this.getEmployees().filter(e => e.id !== id));
    if (emp) { this.audit('حذف موظف', `${emp.name} (${emp.code})`); Sync.del('employees', id); }
  },
  findByCode(code)     { return this.getEmployees().find(e => e.code === code.trim().toUpperCase()); },

  /* ---- أقسام ---- */
  getDepartments()          { return this._get(this._k.depts, []); },
  _saveDepts(arr)           { this._set(this._k.depts, arr); },
  addDepartment(data)       { const d = this.getDepartments(); d.push({ ...data, id: this._uid(), createdAt: this._now() }); this._saveDepts(d); this.audit('إضافة قسم', `${data.name} — ${data.hospital}`); Sync.up('departments', d[d.length - 1]); },
  deleteDepartment(id)      {
    const dep = this.getDepartments().find(d => d.id === id);
    this._saveDepts(this.getDepartments().filter(d => d.id !== id));
    if (dep) { this.audit('حذف قسم', `${dep.name} — ${dep.hospital}`); Sync.del('departments', id); }
  },
  getDeptsByHospital(hosp)  { return this.getDepartments().filter(d => d.hospital === hosp); },

  /* ---- جداول دوام ---- */
  getShifts()        { return this._get(this._k.shifts, []); },
  _saveShifts(arr)   { this._set(this._k.shifts, arr); },
  addShift(data)     { const s = this.getShifts(); s.push({ ...data, id: this._uid(), createdAt: this._now() }); this._saveShifts(s); this.audit('إضافة جدول دوام', `${data.hospital} / ${data.department} (${data.period}) — مطلوب: ${data.requiredCount}`); Sync.up('shifts', s[s.length - 1]); },
  updateShift(id, data) {
    const s = this.getShifts();
    const i = s.findIndex(x => x.id === id);
    if (i < 0) return false;
    s[i] = { ...s[i], ...data };
    this._saveShifts(s);
    this.audit('تعديل جدول دوام', `${data.hospital} / ${data.department} (${data.period})`);
    Sync.up('shifts', s[i]);
    return true;
  },
  deleteShift(id)    {
    const sh = this.getShifts().find(s => s.id === id);
    this._saveShifts(this.getShifts().filter(s => s.id !== id));
    if (sh) { this.audit('حذف جدول دوام', `${sh.hospital} / ${sh.department} (${sh.period})`); Sync.del('shifts', id); }
  },

  /* ---- تقارير ---- */
  getReports()       { return this._get(this._k.reports, []); },
  _saveReports(arr)  { this._set(this._k.reports, arr); },
  addReport(data) {
    const r = this.getReports();
    const report = { ...data, id: this._uid(), status: 'pending', createdAt: this._now() };
    r.push(report);
    this._saveReports(r);
    this.audit('إدخال تقرير', `${report.date} — ${report.hospital || ''} / ${report.department || ''} — بواسطة: ${report.enteredBy || ''}`);
    return report;
  },
  approveReport(id) {
    const r = this.getReports();
    const i = r.findIndex(x => x.id === id);
    if (i < 0) return false;
    const s = this.getSettings();
    r[i].status = 'approved';
    r[i].approvedAt = this._now();
    r[i].approvedBy = s.deputyName || 'النائب الإداري';
    r[i].approverTitle = s.deputyTitle || 'النائب الإداري';
    // إشارة مرجعية للتوقيع بدل نسخه كاملاً في كل تقرير (توفير مساحة التخزين)
    if (s.deputySignature) r[i].sigId = this.addSignatureToReg(s.deputySignature);
    this._saveReports(r);
    this.audit('اعتماد تقرير', `${r[i].date} — ${r[i].hospital || ''} / ${r[i].department || ''} (${r[i].period || ''})`);
    if (r[i].sigId) Sync.upSig(r[i].sigId);
    // الحفظ السحابي يتم مباشرةً (بانتظار النتيجة) من AdminApp.approveReport عبر Sync.pushReportApproval
    return r[i];
  },
  rejectReport(id, reason) {
    const r = this.getReports();
    const i = r.findIndex(x => x.id === id);
    if (i < 0) return false;
    r[i].status = 'rejected';
    r[i].rejectionReason = reason;
    r[i].rejectedAt = this._now();
    this._saveReports(r);
    this.audit('رفض تقرير', `${r[i].date} — ${r[i].hospital || ''} / ${r[i].department || ''} — السبب: ${reason}`);
    Sync.up('reports', r[i]);
    return true;
  },
  deleteReport(id)   {
    const rep = this.getReports().find(r => r.id === id);
    this._saveReports(this.getReports().filter(r => r.id !== id));
    if (rep) { this.audit('حذف تقرير', `${rep.date} — ${rep.hospital || ''} / ${rep.department || ''}`); Sync.del('reports', id); }
  },
  clearReports()     { this._set(this._k.reports, []); this.audit('حذف جميع التقارير', ''); Sync.clearReportsCloud(); },

  /* ---- مساعدات ---- */
  _uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
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
  /* تاريخ بالتوقيت المحلي (وليس UTC) — يمنع انزياح اليوم بعد منتصف الليل */
  localISO(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  today() {
    return this.localISO();
  },
  thisMonth() {
    return this.localISO().slice(0, 7);
  },
  weekRange() {
    const now = new Date();
    const day = now.getDay();
    const sun = new Date(now); sun.setDate(now.getDate() - day);
    const sat = new Date(now); sat.setDate(now.getDate() + (6 - day));
    return { from: this.localISO(sun), to: this.localISO(sat) };
  },
};

/* ======================================================
   الطبقة السحابية (Supabase) — محلي-أولاً مع مزامنة خلفية
   localStorage يبقى ذاكرة العمل؛ السحابة مصدر الحقيقة.
   إن كان config.js بقيمه النائبة يعمل كل شيء محلياً كما قبل.
   ====================================================== */
const Cloud = {
  sb: null,
  init() {
    try {
      if (typeof CLOUD_ENABLED === 'undefined' || !CLOUD_ENABLED) return false;
      if (!window.supabase?.createClient) return false;
      this.sb = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
      return true;
    } catch { return false; }
  },
  on() { return !!this.sb; },
};

const Sync = {
  OUTBOX_KEY: 'mksh_outbox',
  SEEDED_KEY: 'mksh_cloud_seeded',
  _timer: null,
  _flushing: false,

  /* ---- تحويل أسماء الحقول: محلي ↔ سحابي ---- */
  _maps: {
    reports: {
      id: 'client_id', date: 'date', day: 'day', period: 'period', hospital: 'hospital',
      department: 'department', total: 'total', present: 'present', absent: 'absent',
      withdrawn: 'withdrawn', leave: 'leave_count', absentNames: 'absent_names',
      notes: 'notes', enteredBy: 'entered_by', employeeCode: 'employee_code',
      status: 'status', rejectionReason: 'rejection_reason', approvedBy: 'approved_by',
      approverTitle: 'approver_title', sigId: 'sig_id', createdAt: 'created_at',
      approvedAt: 'approved_at', rejectedAt: 'rejected_at',
    },
    employees:   { id: 'client_id', name: 'name', code: 'code', hospital: 'hospital', createdAt: 'created_at' },
    departments: { id: 'client_id', name: 'name', hospital: 'hospital', createdAt: 'created_at' },
    shifts:      { id: 'client_id', hospital: 'hospital', department: 'department', period: 'period', requiredCount: 'required_count', createdAt: 'created_at' },
  },
  toCloud(table, rec) {
    const m = this._maps[table], out = {};
    for (const [l, c] of Object.entries(m)) if (rec[l] !== undefined) out[c] = rec[l];
    return out;
  },
  fromCloud(table, row) {
    const m = this._maps[table], out = {};
    for (const [l, c] of Object.entries(m)) if (row[c] !== undefined && row[c] !== null) out[l] = row[c];
    return out;
  },

  /* ---- صف الانتظار (outbox): كتابات تُعاد محاولتها حتى النجاح ---- */
  _outbox()      { return DB._get(this.OUTBOX_KEY, []); },
  _saveOutbox(a) { DB._set(this.OUTBOX_KEY, a); },
  _queue(op) {
    const box = this._outbox();
    box.push({ ...op, attempts: 0, at: DB._now() });
    this._saveOutbox(box);
    this.flush();
  },

  /* واجهات الإدراج في الصف */
  up(table, rec)          { if (Cloud.on()) this._queue({ kind: 'upsert', table, row: this.toCloud(table, rec) }); },
  del(table, id)          { if (Cloud.on()) this._queue({ kind: 'delete', table, clientId: id }); },
  clearReportsCloud()     { if (Cloud.on()) this._queue({ kind: 'clear_reports' }); },
  upSig(id)               { if (Cloud.on()) { const v = DB.getSignaturesReg()[id]; if (v) this._queue({ kind: 'upsert', table: 'signatures', row: { client_id: id, data_url: v } }); } },
  queueAudit(action, details) { if (Cloud.on()) this._queue({ kind: 'audit', row: { action, details, actor: 'المسؤول' } }); },
  queueSubmit(report, code)   { if (Cloud.on()) this._queue({ kind: 'rpc_submit', code, payload: { ...report, client_id: report.id } }); },

  /* ---- حفظ الاعتماد مباشرةً في Supabase (بانتظار النتيجة، مع كشف فشل RLS) ----
     يعيد { ok, queued?, local?, error? }:
     - ok:true  local:true   → السحابة غير مفعّلة، الحفظ محلي فقط
     - ok:true  queued:true  → لا اتصال، أُضيف لصف الانتظار وسيُزامن لاحقاً
     - ok:false error        → فشل الحفظ (RLS / صلاحيات / خطأ خادم) */
  async pushReportApproval(rec) {
    if (!Cloud.on()) {
      console.warn('[اعتماد] Supabase غير مرتبط — config.js ما زال يحوي القيم النائبة (YOUR-PROJECT-REF). الحفظ محلي فقط في هذا المتصفح ولن يصل أي UPDATE لقاعدة البيانات.');
      return { ok: true, local: true };
    }
    const row = this.toCloud('reports', rec);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._queue({ kind: 'upsert', table: 'reports', row });
      return { ok: true, queued: true };
    }
    const patch = {
      status:         row.status,
      approved_by:    row.approved_by    ?? null,
      approver_title: row.approver_title ?? null,
      approved_at:    row.approved_at    ?? null,
      sig_id:         row.sig_id         ?? null,
    };
    try {
      // (1) قراءة الصف قبل UPDATE — تشخيص + كشف مشاكل SELECT/الجلسة مبكراً
      const { data: before, error: beforeErr } = await Cloud.sb.from('reports')
        .select('client_id,status,approved_by,approver_title,approved_at')
        .eq('client_id', rec.id).maybeSingle();
      if (beforeErr) {
        console.error('[اعتماد][قبل UPDATE] فشل SELECT — غالباً جلسة Supabase Auth غير فعّالة أو المستخدم ليس في admin_users:', beforeErr);
        return { ok: false, error: beforeErr };
      }
      console.log('[اعتماد][قبل UPDATE]', before ?? '(الصف غير موجود في السحابة بعد)');

      // (2) UPDATE مع select() — إن أعاد صفراً من الصفوف مع وجود الصف فالسبب RLS
      const { data, error } = await Cloud.sb.from('reports')
        .update(patch).eq('client_id', rec.id).select('client_id,status,approved_by,approver_title,approved_at');
      console.log('[اعتماد][نتيجة UPDATE]', error ?? data);
      if (error) return { ok: false, error };

      if (!data?.length) {
        if (before) {
          return { ok: false, error: new Error(
            'RLS منع تحديث الصف (policy "admin update reports") — تأكد أن مستخدم المسؤول مسجّل في جدول admin_users وأن الدخول تم عبر Supabase Auth') };
        }
        // الصف غير موجود بالسحابة بعد → إدراجه كاملاً
        const { error: upErr } = await Cloud.sb.from('reports').upsert(row, { onConflict: 'client_id' });
        if (upErr) { console.error('[اعتماد] فشل upsert:', upErr); return { ok: false, error: upErr }; }
      }

      // (3) إعادة تحميل السجل من قاعدة البيانات (وليس من الذاكرة المحلية) للتحقق النهائي
      const { data: fresh, error: freshErr } = await Cloud.sb.from('reports')
        .select('*').eq('client_id', rec.id).maybeSingle();
      console.log('[اعتماد][بعد UPDATE — أُعيد تحميله من قاعدة البيانات]', freshErr ?? fresh);
      if (freshErr) return { ok: false, error: freshErr };
      if (!fresh || fresh.status !== 'approved') {
        return { ok: false, error: new Error('الحالة في قاعدة البيانات ما زالت "' + (fresh?.status ?? 'غير موجود') + '" رغم عدم ظهور خطأ — راجع سياسات RLS') };
      }
      // مزامنة النسخة المحلية من نسخة قاعدة البيانات المؤكدة
      const local = DB.getReports();
      const i = local.findIndex(x => x.id === rec.id);
      if (i >= 0) { local[i] = { ...local[i], ...this.fromCloud('reports', fresh) }; DB._saveReports(local); }
      return { ok: true };
    } catch (e) {
      // خطأ شبكة → صف الانتظار لإعادة المحاولة
      console.warn('[اعتماد] خطأ شبكة — أُضيف للمزامنة اللاحقة:', e);
      this._queue({ kind: 'upsert', table: 'reports', row });
      return { ok: true, queued: true };
    }
  },

  async flush() {
    if (!Cloud.on() || this._flushing || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    this._flushing = true;
    try {
      const box = this._outbox();
      if (!box.length) return;
      const remaining = [];
      for (const op of box) {
        try {
          let error = null;
          if (op.kind === 'upsert')             ({ error } = await Cloud.sb.from(op.table).upsert(op.row, { onConflict: 'client_id' }));
          else if (op.kind === 'delete')        ({ error } = await Cloud.sb.from(op.table).delete().eq('client_id', op.clientId));
          else if (op.kind === 'clear_reports') ({ error } = await Cloud.sb.from('reports').delete().gte('created_at', '1970-01-01'));
          else if (op.kind === 'audit')         ({ error } = await Cloud.sb.from('audit_log').insert(op.row));
          else if (op.kind === 'rpc_submit') {
            // 'duplicate' و'invalid_code' نتائج نهائية — لا يعاد إرسالها
            ({ error } = await Cloud.sb.rpc('submit_report', { p_code: op.code, p: op.payload }));
          }
          if (error) throw error;
        } catch (e) {
          op.attempts = (op.attempts || 0) + 1;
          if (op.attempts < 25) remaining.push(op); // تجاهل العملية بعد 25 محاولة فاشلة
        }
      }
      // احتفظ بالعمليات التي أُضيفت للصف أثناء الإرسال (منع حالة التسابق)
      const appended = this._outbox().slice(box.length);
      this._saveOutbox([...remaining, ...appended]);
    } finally { this._flushing = false; }
  },

  /* ---- السحب من السحابة ---- */
  async pullDepartments() {
    if (!Cloud.on()) return;
    try {
      const { data, error } = await Cloud.sb.from('departments').select('*');
      if (!error && Array.isArray(data) && data.length) {
        DB._set(DB._k.depts, data.map(r => this.fromCloud('departments', r)));
      }
    } catch { /* دون اتصال — تبقى النسخة المحلية */ }
  },

  async pullAll() {
    if (!Cloud.on()) return false;
    // لا سحب وفي الصف كتابات لم تُرسل بعد (حتى لا تُمحى تعديلات محلية)
    await this.flush();
    if (this._outbox().length) return false;
    try {
      const { data: sess } = await Cloud.sb.auth.getSession();
      if (!sess?.session) return false;
      const tables = [['departments', DB._k.depts], ['employees', DB._k.emps], ['shifts', DB._k.shifts], ['reports', DB._k.reports]];
      const fetched = {};
      for (const [t] of tables) {
        const { data, error } = await Cloud.sb.from(t).select('*');
        if (error) return false;
        fetched[t] = data;
      }
      const { data: sigs, error: sigErr } = await Cloud.sb.from('signatures').select('*');
      if (sigErr) return false;
      // الكتابة المحلية بعد نجاح كل الطلبات فقط (كل شيء أو لا شيء)
      for (const [t, key] of tables) DB._set(key, fetched[t].map(r => this.fromCloud(t, r)));
      const reg = {};
      sigs.forEach(s => { reg[s.client_id || s.id] = s.data_url; });
      DB._set(DB._k.sigs, reg);
      return true;
    } catch { return false; }
  },

  /* ---- الرفع الأولي: نقل البيانات المحلية للسحابة (آمن للإعادة — upsert) ---- */
  async uploadLocal() {
    const chunk = async (table, rows) => {
      for (let i = 0; i < rows.length; i += 100) {
        const { error } = await Cloud.sb.from(table).upsert(rows.slice(i, i + 100), { onConflict: 'client_id' });
        if (error) throw error;
      }
    };
    await chunk('departments', DB.getDepartments().map(r => this.toCloud('departments', r)));
    await chunk('employees',   DB.getEmployees().map(r => this.toCloud('employees', r)));
    await chunk('shifts',      DB.getShifts().map(r => this.toCloud('shifts', r)));
    await chunk('signatures',  Object.entries(DB.getSignaturesReg()).map(([id, v]) => ({ client_id: id, data_url: v })));
    await chunk('reports',     DB.getReports().map(r => this.toCloud('reports', r)));
    localStorage.setItem(this.SEEDED_KEY, '1');
  },

  isSeeded() { return localStorage.getItem(this.SEEDED_KEY) === '1'; },

  /* ---- بعد دخول المسؤول: رفع أولي إن لزم، ثم سحب دوري ---- */
  async onAdminLogin() {
    if (!Cloud.on()) {
      console.warn('[مزامنة] Supabase غير مرتبط: config.js يحوي القيم النائبة (YOUR-PROJECT-REF / YOUR-ANON) — كل البيانات محلية في هذا المتصفح فقط ولن يُحفظ أي شيء في قاعدة البيانات.');
      Toast.show('تنبيه: المنصة تعمل بوضع التخزين المحلي فقط — لم يتم ربط Supabase بعد (أدخل بيانات المشروع في config.js)', 'warning', 8000);
      return;
    }
    const hasLocalData = DB.getReports().length || DB.getEmployees().length || DB.getDepartments().length;
    if (!this.isSeeded() && hasLocalData) {
      AdminApp._confirm('يوجد بيانات محفوظة في هذا المتصفح لم تُرفع إلى السحابة بعد. رفعها الآن؟ (لن يُحذف أو يُكرر شيء)', async () => {
        try {
          await this.uploadLocal();
          Toast.show('تم رفع البيانات المحلية إلى السحابة بنجاح', 'success');
          await this._refresh();
        } catch (e) {
          Toast.show('تعذر الرفع — ستتم إعادة المحاولة في الدخول القادم', 'error');
        }
      });
      // لا سحب قبل اكتمال الرفع الأولي — حمايةً من محو البيانات المحلية
    } else {
      if (!this.isSeeded()) localStorage.setItem(this.SEEDED_KEY, '1'); // لا بيانات محلية أصلاً
      await this._refresh();
    }
    if (!this._timer) {
      this._timer = setInterval(() => this._refresh(), 60000);
      window.addEventListener('online', () => this.flush());
    }
  },

  async _refresh() {
    if (!this.isSeeded()) return;
    const ok = await this.pullAll();
    if (!ok) return;
    // إعادة رسم القسم الحالي — إلا أثناء فتح نافذة أو الكتابة في حقل
    const modalOpen = document.querySelector('.modal-overlay.open');
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (!modalOpen && !typing && document.getElementById('adminContent')?.style.display !== 'none') {
      AdminApp.showSection(AdminApp.currentSection);
      AdminApp._updatePendingBadge();
      AdminApp.renderAlerts();
    }
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
  dashPeriodType: 'daily',

  init() {
    DB.migrateSignatures(); // ترحيل التوقيعات المضمّنة القديمة إلى السجل المرجعي
    if (!DB.isAdminLoggedIn()) {
      document.getElementById('adminLogin').style.display = 'flex';
      document.getElementById('adminContent').style.display = 'none';
      const inp = document.getElementById('adminPassInput');
      if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });
      // استعادة جلسة سحابية سابقة (Supabase يحفظها بين الزيارات) — مع التحقق من صلاحيات admin_users
      if (Cloud.on()) {
        Cloud.sb.auth.getSession().then(async ({ data }) => {
          if (!data?.session) return;
          if (await this._verifyAdminRole()) { DB.setAdminSession(); this._showApp(); }
          else Cloud.sb.auth.signOut().catch(() => {});
        }).catch(() => {});
      }
    } else {
      this._showApp();
    }
  },

  /* التحقق أن المستخدم المسجَّل حالياً موجود في جدول admin_users (صلاحيات المسؤول) */
  async _verifyAdminRole() {
    try {
      const { data, error } = await Cloud.sb.from('admin_users').select('user_id').maybeSingle();
      if (error) { console.error('[صلاحيات] فشل التحقق من admin_users:', error); return false; }
      if (!data) console.warn('[صلاحيات] كلمة المرور صحيحة لكن المستخدم غير مسجّل في جدول admin_users — نفّذ سطر INSERT الموجود نهاية supabase-schema.sql');
      return !!data;
    } catch (e) { console.error('[صلاحيات] خطأ غير متوقع أثناء التحقق:', e); return false; }
  },

  async login() {
    const inp = document.getElementById('adminPassInput');
    const err = document.getElementById('loginError');
    if (!inp || !err) return;

    let ok;
    if (Cloud.on()) {
      // مصادقة حقيقية عبر Supabase Auth — البريد داخلي من config.js والواجهة كما هي
      try {
        const { error } = await Cloud.sb.auth.signInWithPassword({
          email: SUPABASE_CONFIG.adminEmail,
          password: inp.value,
        });
        ok = !error;
        // كلمة المرور صحيحة لكن المستخدم ليس مسؤولاً؟ أوقف الدخول برسالة واضحة
        if (ok && !(await this._verifyAdminRole())) {
          await Cloud.sb.auth.signOut().catch(() => {});
          Toast.show('كلمة المرور صحيحة لكن المستخدم غير مسجّل في جدول admin_users — نفّذ في SQL Editor السطر الموجود نهاية supabase-schema.sql', 'error', 9000);
          DB.audit('دخول مرفوض', 'المستخدم غير مسجّل في admin_users');
          err.classList.add('show');
          inp.value = '';
          inp.focus();
          return;
        }
      } catch { ok = false; }
    } else {
      ok = await DB.verifyPass(inp.value);
    }

    if (ok) {
      DB.setAdminSession();
      DB.audit('تسجيل دخول المسؤول', 'دخول ناجح');
      err.classList.remove('show');
      this._showApp();
    } else {
      DB.audit('محاولة دخول فاشلة', 'كلمة مرور غير صحيحة');
      err.classList.add('show');
      inp.value = '';
      inp.focus();
    }
  },

  logout() {
    const bye = () => { DB.clearAdminSession(); location.reload(); };
    if (Cloud.on()) Cloud.sb.auth.signOut().then(bye).catch(bye);
    else bye();
  },

  _showApp() {
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

    this.showSection('dashboard');
    this.setDashPeriodTab(this.dashPeriodType || 'daily');
    this._updatePendingBadge();
    this.renderAlerts();
    Sync.onAdminLogin(); // رفع أولي إن لزم + سحب دوري (لا يفعل شيئاً بلا سحابة)
  },

  showSection(name) {
    document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const sec = document.getElementById(`sec-${name}`);
    if (sec) sec.classList.add('active');
    const nav = document.querySelector(`.nav-item[data-section="${name}"]`);
    if (nav) nav.classList.add('active');
    this.currentSection = name;

    const titles = {
      dashboard: 'لوحة التحكم', analytics: 'التحليلات الذكية', employees: 'أكواد الموظفين', shifts: 'جداول الدوام',
      departments: 'إدارة الأقسام', reports: 'سجل التقارير',
      daily: 'التقرير اليومي', weekly: 'التقرير الأسبوعي', monthly: 'التقرير الشهري',
      audit: 'سجل التدقيق',
      settings: 'الإعدادات',
    };
    const el = document.getElementById('topBarTitle');
    if (el) el.textContent = titles[name] || name;

    const loaders = {
      dashboard:   () => this.loadDashboard(),
      analytics:   () => this.loadAnalytics(),
      employees:   () => this.renderEmployees(),
      shifts:      () => this.renderShifts(),
      departments: () => this.renderDepts(),
      reports:     () => this.renderReports(),
      daily:       () => this.renderDailyReport(),
      weekly:      () => this.renderWeeklyReport(),
      monthly:     () => this.renderMonthlyReport(),
      audit:       () => this.renderAudit(),
      settings:    () => this.loadSettingsUI(),
    };
    if (loaders[name]) loaders[name]();

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

  _updatePendingBadge() {
    const pending = DB.getReports().filter(r => r.status === 'pending').length;
    const badge = document.getElementById('pendingBadge');
    if (!badge) return;
    if (pending > 0) { badge.style.display = 'inline'; badge.textContent = pending; }
    else { badge.style.display = 'none'; }
  },

  /* ====== لوحة التحكم ====== */
  loadDashboard() {
    const hospital = document.getElementById('dashHospital')?.value || '';
    const period   = document.getElementById('dashPeriod')?.value   || '';
    const dateFrom = document.getElementById('dashDateFrom')?.value || '';
    const dateTo   = document.getElementById('dashDateTo')?.value   || '';

    let reports = DB.getReports();
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
            <td>${esc(r.date)}</td>
            <td>${esc(r.hospital) || '-'}</td>
            <td>${esc(r.department) || '-'}</td>
            <td>${esc(r.period) || '-'}</td>
            <td>${r.present || 0}</td>
            <td>${r.absent || 0}</td>
            <td>${r.withdrawn || 0}</td>
            <td>${esc(r.enteredBy) || '-'}</td>
            <td>${this._statusBadge(r.status)}</td>
          </tr>`).join('');
      }
    }

    this._loadKPIs();
    this._loadHospitalCompareReport();
  },

  resetDashFilter() {
    ['dashHospital','dashPeriod'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    this.setDashPeriodTab(this.dashPeriodType || 'daily');
  },

  /* ====== تبويب الفترة (يومي/أسبوعي/شهري) ====== */
  setDashPeriodTab(type) {
    this.dashPeriodType = type;
    document.querySelectorAll('#dashPeriodTabs .report-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.period === type);
    });
    const range = this._periodRange(type, 0);
    const df = document.getElementById('dashDateFrom');
    const dt = document.getElementById('dashDateTo');
    if (df) df.value = range.from;
    if (dt) dt.value = range.to;
    this.loadDashboard();
  },

  _periodRange(type, offset = 0) {
    const now = new Date();
    if (type === 'weekly') {
      const day = now.getDay();
      const sun = new Date(now); sun.setDate(now.getDate() - day + offset * 7);
      const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
      return { from: DB.localISO(sun), to: DB.localISO(sat) };
    }
    if (type === 'monthly') {
      const base = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return { from: DB.localISO(base), to: DB.localISO(last) };
    }
    // daily (افتراضي)
    const d = new Date(now); d.setDate(d.getDate() + offset);
    const iso = DB.localISO(d);
    return { from: iso, to: iso };
  },

  _prevRange(from, to) {
    const f = new Date(from + 'T00:00:00');
    const t = new Date(to + 'T00:00:00');
    const days = Math.round((t - f) / 86400000) + 1;
    const prevTo = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (days - 1));
    return { from: DB.localISO(prevFrom), to: DB.localISO(prevTo) };
  },

  /* ====== مؤشرات الأداء (KPI) ====== */
  _computeRates(reports) {
    const totals = reports.reduce((a, r) => {
      a.present += +r.present || 0; a.absent += +r.absent || 0;
      a.withdrawn += +r.withdrawn || 0; a.leave += +r.leave || 0;
      return a;
    }, { present:0, absent:0, withdrawn:0, leave:0 });
    const denom = totals.present + totals.absent + totals.withdrawn + totals.leave;
    const attendanceRate = denom ? (totals.present / denom) * 100 : 0;
    const absenceRate    = denom ? (totals.absent   / denom) * 100 : 0;

    // نسبة التغطية: الحضور الفعلي مقابل العدد المطلوب في جداول الدوام المطابقة
    const shifts = DB.getShifts();
    let reqSum = 0, presentForReq = 0;
    reports.forEach(r => {
      const shift = shifts.find(s => s.hospital === r.hospital && s.department === r.department && s.period === r.period);
      if (shift) { reqSum += (+shift.requiredCount || 0); presentForReq += (+r.present || 0); }
    });
    const coverageRate = reqSum ? (presentForReq / reqSum) * 100 : null;

    const approved = reports.filter(r => r.status === 'approved').length;
    const approvalRate = reports.length ? (approved / reports.length) * 100 : 0;

    return { attendanceRate, absenceRate, coverageRate, approvalRate, count: reports.length, totals };
  },

  _renderKpi(key, curVal, prevVal, inverse = false) {
    const valEl = document.getElementById(`kpiVal-${key}`);
    const trendEl = document.getElementById(`kpiTrend-${key}`);
    if (valEl) valEl.textContent = curVal === null ? '—' : `${Math.round(curVal)}%`;
    if (!trendEl) return;
    if (curVal === null || prevVal === null) { trendEl.innerHTML = ''; return; }
    const diff = curVal - prevVal;
    if (Math.abs(diff) < 0.5) {
      trendEl.innerHTML = `<span style="color:var(--text-muted)"><i class="fas fa-minus"></i> 0%</span>`;
      return;
    }
    const improved = inverse ? diff < 0 : diff > 0;
    const color = improved ? 'var(--success)' : 'var(--danger)';
    const icon  = diff > 0 ? 'fa-arrow-up' : 'fa-arrow-down';
    trendEl.innerHTML = `<span style="color:${color};font-weight:700"><i class="fas ${icon}"></i> ${Math.abs(Math.round(diff))}%</span>`;
  },

  _loadKPIs() {
    const hospital   = document.getElementById('dashHospital')?.value || '';
    const periodFlt  = document.getElementById('dashPeriod')?.value   || '';
    const dateFrom   = document.getElementById('dashDateFrom')?.value || DB.today();
    const dateTo     = document.getElementById('dashDateTo')?.value   || DB.today();
    const prev = this._prevRange(dateFrom, dateTo);

    const filterFn = (from, to) => {
      let reports = DB.getReports().filter(r => r.date >= from && r.date <= to);
      if (hospital)  reports = reports.filter(r => r.hospital === hospital);
      if (periodFlt) reports = reports.filter(r => r.period   === periodFlt);
      return reports;
    };

    const cur = this._computeRates(filterFn(dateFrom, dateTo));
    const prv = this._computeRates(filterFn(prev.from, prev.to));

    this._renderKpi('attendance', cur.attendanceRate, prv.attendanceRate);
    this._renderKpi('absence',    cur.absenceRate,    prv.absenceRate, true);
    this._renderKpi('coverage',   cur.coverageRate,   prv.coverageRate);
    this._renderKpi('approval',   cur.approvalRate,   prv.approvalRate);
  },

  /* ====== تقرير مقارنة المستشفيات الثلاث ====== */
  _buildHospitalCompareData() {
    const periodFlt = document.getElementById('dashPeriod')?.value   || '';
    const dateFrom   = document.getElementById('dashDateFrom')?.value || DB.today();
    const dateTo     = document.getElementById('dashDateTo')?.value   || DB.today();
    let reports = DB.getReports().filter(r => r.date >= dateFrom && r.date <= dateTo);
    if (periodFlt) reports = reports.filter(r => r.period === periodFlt);

    return DB.HOSPITALS.map(h => {
      const hReports = reports.filter(r => r.hospital === h);
      const rates = this._computeRates(hReports);
      return {
        hospital: h,
        present: rates.totals.present, absent: rates.totals.absent,
        withdrawn: rates.totals.withdrawn, leave: rates.totals.leave,
        attendanceRate: rates.attendanceRate, coverageRate: rates.coverageRate,
        reportsCount: hReports.length,
      };
    });
  },

  _loadHospitalCompareReport() {
    const data = this._buildHospitalCompareData();
    const body = document.getElementById('hospitalCompareBody');
    if (!body) return;
    body.innerHTML = data.map(d => `
      <tr>
        <td><strong>${d.hospital}</strong></td>
        <td><span style="color:var(--success);font-weight:700">${d.present}</span></td>
        <td><span style="color:var(--danger);font-weight:700">${d.absent}</span></td>
        <td>${d.withdrawn}</td>
        <td>${d.leave}</td>
        <td>${d.reportsCount ? Math.round(d.attendanceRate) + '%' : '-'}</td>
        <td>${d.coverageRate === null ? '<span class="badge badge-primary">لا توجد بيانات</span>' : Math.round(d.coverageRate) + '%'}</td>
        <td>${d.reportsCount}</td>
      </tr>`).join('');
  },

  printHospitalCompare() {
    const data = this._buildHospitalCompareData();
    const dateFrom = document.getElementById('dashDateFrom')?.value || DB.today();
    const dateTo   = document.getElementById('dashDateTo')?.value   || DB.today();
    const rowsHtml = data.map(d => `
      <tr>
        <td>${d.hospital}</td><td>${d.present}</td><td>${d.absent}</td><td>${d.withdrawn}</td><td>${d.leave}</td>
        <td>${d.reportsCount ? Math.round(d.attendanceRate) + '%' : '-'}</td>
        <td>${d.coverageRate === null ? '-' : Math.round(d.coverageRate) + '%'}</td>
        <td>${d.reportsCount}</td>
      </tr>`).join('');

    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { Toast.show('يرجى السماح بالنوافذ المنبثقة لإتاحة الطباعة', 'warning'); return; }
    win.document.write(`
      <html lang="ar" dir="rtl"><head><meta charset="UTF-8">
      <title>تقرير مقارنة المستشفيات الثلاث</title>
      <style>
        body{font-family:Tahoma,Arial,sans-serif;padding:30px;color:#1e2d3d}
        h1{font-size:19px;margin-bottom:4px}
        p{color:#5a6a7e;font-size:13px;margin-bottom:20px}
        table{width:100%;border-collapse:collapse;font-size:14px}
        th,td{border:1px solid #d5dde8;padding:10px 12px;text-align:center}
        th{background:#f5f8fc}
      </style></head>
      <body>
        <h1>تقرير مقارنة المستشفيات الثلاث — مدينة الملك سلمان الطبية</h1>
        <p>الفترة: من ${dateFrom} إلى ${dateTo}</p>
        <table>
          <thead><tr>
            <th>المستشفى</th><th>الحضور</th><th>الغياب</th><th>الانسحاب</th><th>الإجازة</th>
            <th>معدل الحضور</th><th>نسبة التغطية</th><th>عدد التقارير</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  },

  exportHospitalCompare() {
    const data = this._buildHospitalCompareData();
    if (!data.some(d => d.reportsCount)) return Toast.show('لا توجد بيانات للتصدير في هذه الفترة', 'warning');
    const rows = data.map(d => ({
      'المستشفى': d.hospital,
      'الحضور': d.present,
      'الغياب': d.absent,
      'الانسحاب': d.withdrawn,
      'الإجازات': d.leave,
      'معدل الحضور %': d.reportsCount ? Math.round(d.attendanceRate) : '-',
      'نسبة التغطية %': d.coverageRate === null ? '-' : Math.round(d.coverageRate),
      'عدد التقارير': d.reportsCount,
    }));
    if (typeof XLSX !== 'undefined') {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{wch:24},{wch:10},{wch:10},{wch:10},{wch:10},{wch:14},{wch:14},{wch:12}];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'مقارنة المستشفيات');
      XLSX.writeFile(wb, `مقارنة_المستشفيات_${this.dashPeriodType || 'يومي'}.xlsx`);
      Toast.show('تم تصدير ملف Excel بنجاح', 'success');
    } else {
      Toast.show('تعذر تحميل مكتبة التصدير', 'error');
    }
  },

  /* ====== التحليلات الذكية ====== */
  _charts: {},

  _renderChart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (this._charts[canvasId]) this._charts[canvasId].destroy();
    this._charts[canvasId] = new Chart(canvas.getContext('2d'), config);
  },

  resetAnaFilter() {
    ['anaHospital','anaPeriod','anaDateFrom','anaDateTo'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    this.loadAnalytics();
  },

  _filteredAnaReports() {
    const hospital = document.getElementById('anaHospital')?.value || '';
    const period   = document.getElementById('anaPeriod')?.value   || '';
    const dateFrom = document.getElementById('anaDateFrom')?.value || '';
    const dateTo   = document.getElementById('anaDateTo')?.value   || '';
    let reports = DB.getReports();
    if (hospital) reports = reports.filter(r => r.hospital === hospital);
    if (period)   reports = reports.filter(r => r.period   === period);
    if (dateFrom) reports = reports.filter(r => r.date >= dateFrom);
    if (dateTo)   reports = reports.filter(r => r.date <= dateTo);
    return reports;
  },

  loadAnalytics() {
    const reports = this._filteredAnaReports();

    // ---- معدل الحضور العام ----
    const totals = reports.reduce((a, r) => {
      a.present += +r.present || 0; a.absent += +r.absent || 0;
      a.withdrawn += +r.withdrawn || 0; a.leave += +r.leave || 0;
      return a;
    }, { present:0, absent:0, withdrawn:0, leave:0 });
    const denom = totals.present + totals.absent + totals.withdrawn + totals.leave;
    const rate = denom ? Math.round((totals.present / denom) * 100) : 0;
    const rateEl = document.getElementById('ana-rate');
    if (rateEl) rateEl.textContent = `${rate}%`;

    // ---- اتجاه الحضور والغياب عبر الزمن ----
    const byDate = {};
    reports.forEach(r => {
      if (!byDate[r.date]) byDate[r.date] = { present: 0, absent: 0 };
      byDate[r.date].present += +r.present || 0;
      byDate[r.date].absent  += +r.absent  || 0;
    });
    const dates = Object.keys(byDate).sort().slice(-30);
    this._renderChart('chartTrend', {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          { label: 'الحضور', data: dates.map(d => byDate[d].present), borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,.12)', tension: .3, fill: true },
          { label: 'الغياب',  data: dates.map(d => byDate[d].absent),  borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,.12)', tension: .3, fill: true },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
    });

    // ---- مقارنة المستشفيات ----
    const byHosp = {};
    DB.HOSPITALS.forEach(h => { byHosp[h] = { present: 0, absent: 0 }; });
    reports.forEach(r => {
      if (byHosp[r.hospital]) {
        byHosp[r.hospital].present += +r.present || 0;
        byHosp[r.hospital].absent  += +r.absent  || 0;
      }
    });
    this._renderChart('chartHospitalCompare', {
      type: 'bar',
      data: {
        labels: DB.HOSPITALS,
        datasets: [
          { label: 'الحضور', data: DB.HOSPITALS.map(h => byHosp[h].present), backgroundColor: '#2980b9' },
          { label: 'الغياب',  data: DB.HOSPITALS.map(h => byHosp[h].absent),  backgroundColor: '#e74c3c' },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { x: { ticks: { font: { size: 10 } } } } },
    });

    // ---- توزيع حالة التقارير ----
    const statusCount = { pending: 0, approved: 0, rejected: 0 };
    reports.forEach(r => { if (statusCount[r.status] !== undefined) statusCount[r.status]++; });
    this._renderChart('chartStatusDist', {
      type: 'doughnut',
      data: {
        labels: ['معتمد', 'بانتظار الاعتماد', 'مرفوض'],
        datasets: [{ data: [statusCount.approved, statusCount.pending, statusCount.rejected], backgroundColor: ['#27ae60', '#8e44ad', '#e74c3c'] }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
    });

    // ---- الأكثر تكراراً في الغياب ----
    const nameCounts = {};
    reports.forEach(r => {
      if (!r.absentNames) return;
      r.absentNames.split(/[,،\n]+/).map(s => s.trim()).filter(Boolean).forEach(name => {
        nameCounts[name] = (nameCounts[name] || 0) + 1;
      });
    });
    const topAbsentees = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const absenteeEl = document.getElementById('ana-absenteeCount');
    if (absenteeEl) absenteeEl.textContent = topAbsentees.filter(([, c]) => c >= 2).length;

    const listEl = document.getElementById('topAbsenteesList');
    if (listEl) {
      if (!topAbsentees.length) {
        listEl.innerHTML = `<div class="empty-state" style="padding:30px"><i class="fas fa-user-check"></i><p>لا توجد بيانات غياب مسجلة بالاسم</p></div>`;
      } else {
        const max = topAbsentees[0][1];
        listEl.innerHTML = topAbsentees.map(([name, count]) => `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
                <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</strong>
                <span style="color:var(--text-muted)">${count} مرة</span>
              </div>
              <div style="background:var(--surface-2);border-radius:6px;height:8px;overflow:hidden">
                <div style="background:${count >= 3 ? 'var(--danger)' : 'var(--warning)'};height:100%;width:${Math.max(8, (count / max) * 100)}%"></div>
              </div>
            </div>
          </div>`).join('');
      }
    }

    // ---- تحليل فجوة التغطية ----
    const shifts = DB.getShifts();
    const gapBody = document.getElementById('coverageGapBody');
    let gapCount = 0;
    if (gapBody) {
      if (!shifts.length) {
        gapBody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fas fa-calendar-alt"></i><p>لم يتم إضافة جداول دوام بعد</p></div></td></tr>`;
      } else {
        const rows = shifts.map(s => {
          const matching = reports.filter(r => r.hospital === s.hospital && r.department === s.department && r.period === s.period);
          const avgPresent = matching.length ? Math.round(matching.reduce((a, r) => a + (+r.present || 0), 0) / matching.length) : null;
          const required = +s.requiredCount || 0;
          if (avgPresent === null) {
            return `<tr>
              <td style="font-size:13px">${esc(s.hospital)}</td><td>${esc(s.department)}</td><td><span class="badge badge-info">${esc(s.period)}</span></td>
              <td>${required}</td><td>-</td><td>-</td><td><span class="badge badge-primary">لا توجد بيانات</span></td>
            </tr>`;
          }
          const gap = required - avgPresent;
          let statusBadge;
          if (gap <= 0) statusBadge = `<span class="badge badge-success"><i class="fas fa-check"></i> مكتملة</span>`;
          else {
            gapCount++;
            const ratio = required ? gap / required : 0;
            if (ratio >= 0.3) statusBadge = `<span class="badge badge-danger"><i class="fas fa-triangle-exclamation"></i> نقص حرج</span>`;
            else if (ratio >= 0.15) statusBadge = `<span class="badge badge-warning"><i class="fas fa-exclamation"></i> نقص متوسط</span>`;
            else statusBadge = `<span class="badge badge-pending"><i class="fas fa-info"></i> نقص بسيط</span>`;
          }
          return `<tr>
            <td style="font-size:13px">${esc(s.hospital)}</td><td>${esc(s.department)}</td><td><span class="badge badge-info">${esc(s.period)}</span></td>
            <td>${required}</td><td>${avgPresent}</td>
            <td style="color:${gap > 0 ? 'var(--danger)' : 'var(--success)'};font-weight:700">${gap > 0 ? gap : 0}</td>
            <td>${statusBadge}</td>
          </tr>`;
        });
        gapBody.innerHTML = rows.join('');
      }
    }
    const gapCountEl = document.getElementById('ana-gapCount');
    if (gapCountEl) gapCountEl.textContent = gapCount;
  },

  /* ====== موظفون ====== */
  renderEmployees() {
    const search = (document.getElementById('empSearchInput')?.value || '').toLowerCase();
    let emps = DB.getEmployees();
    if (search) emps = emps.filter(e => e.name.toLowerCase().includes(search) || e.code.toLowerCase().includes(search));
    const tbody = document.getElementById('employeesBody');
    if (!tbody) return;
    if (!emps.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fas fa-id-card"></i><p>${search ? 'لا توجد نتائج' : 'لم يتم إضافة موظفين بعد'}</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = emps.map((e, i) => `
      <tr>
        <td>${i+1}</td>
        <td><strong>${esc(e.name)}</strong></td>
        <td><code style="background:#f0f4f8;padding:3px 10px;border-radius:6px;font-size:13px;letter-spacing:1px">${esc(e.code)}</code></td>
        <td>${esc(e.hospital) || '<span class="text-muted">—</span>'}</td>
        <td style="font-size:13px;color:var(--text-muted)">${DB.formatDate(e.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-outline btn-sm btn-icon" title="تعديل" onclick="AdminApp.editEmployee('${esc(e.id)}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" title="حذف" onclick="AdminApp.deleteEmployee('${esc(e.id)}')"><i class="fas fa-trash"></i></button>
        </div></td>
      </tr>`).join('');
  },

  openEmpModal(emp) {
    document.getElementById('empEditId').value = emp?.id || '';
    document.getElementById('empName').value = emp?.name || '';
    document.getElementById('empCode').value = emp?.code || '';
    document.getElementById('empHospital').value = emp?.hospital || '';
    document.getElementById('empModalTitle').textContent = emp ? 'تعديل بيانات الموظف' : 'إضافة موظف جديد';
    this.openModal('empModal');
  },

  editEmployee(id) {
    const emp = DB.getEmployees().find(e => e.id === id);
    if (emp) this.openEmpModal(emp);
  },

  saveEmployee() {
    const id   = document.getElementById('empEditId').value;
    const name = document.getElementById('empName').value.trim();
    const code = document.getElementById('empCode').value.trim().toUpperCase();
    const hospital = document.getElementById('empHospital').value;

    if (!name) return Toast.show('يرجى إدخال اسم الموظف', 'error');
    if (!code) return Toast.show('يرجى إدخال الكود الخاص', 'error');
    if (!/^[A-Z0-9\-_]+$/i.test(code)) return Toast.show('الكود يجب أن يحتوي على حروف وأرقام فقط', 'error');

    const result = id
      ? DB.updateEmployee(id, { name, code, hospital })
      : DB.addEmployee({ name, code, hospital });

    if (!result.ok) return Toast.show(result.msg, 'error');
    Toast.show(id ? 'تم تحديث بيانات الموظف' : 'تمت إضافة الموظف بنجاح', 'success');
    this.closeModal('empModal');
    this.renderEmployees();
  },

  deleteEmployee(id, name) {
    // الاسم يُجلب من قاعدة البيانات بالمعرّف (تمريره عبر onclick غير آمن مع علامات الاقتباس)
    name = name || DB.getEmployees().find(e => e.id === id)?.name || '';
    this._confirm(`هل تريد حذف الموظف "${name}"؟`, () => {
      DB.deleteEmployee(id);
      Toast.show('تم حذف الموظف', 'success');
      this.renderEmployees();
    });
  },

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const existing = new Set(DB.getEmployees().map(e => e.code));
    let code;
    do {
      code = 'EMP';
      for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    } while (existing.has(code)); // ضمان عدم تكرار الكود المولَّد
    document.getElementById('empCode').value = code;
  },

  /* ====== جداول الدوام ====== */
  renderShifts() {
    const shifts = DB.getShifts();
    const tbody = document.getElementById('shiftsBody');
    if (!tbody) return;
    if (!shifts.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fas fa-calendar-alt"></i><p>لم يتم إضافة جداول دوام بعد</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = shifts.map((s, i) => `
      <tr>
        <td>${i+1}</td>
        <td>${esc(s.hospital)}</td>
        <td>${esc(s.department)}</td>
        <td><span class="badge badge-info">${esc(s.period)}</span></td>
        <td><strong>${s.requiredCount}</strong> موظف</td>
        <td style="font-size:13px;color:var(--text-muted)">${DB.formatDate(s.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-outline btn-sm btn-icon" title="تعديل" onclick="AdminApp.editShift('${s.id}')"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" title="حذف" onclick="AdminApp.deleteShift('${s.id}')"><i class="fas fa-trash"></i></button>
        </div></td>
      </tr>`).join('');
  },

  openShiftModal(shift) {
    document.getElementById('shiftEditId').value = shift?.id || '';
    document.getElementById('shiftHospital').value  = shift?.hospital || '';
    document.getElementById('shiftPeriod').value    = shift?.period   || '';
    document.getElementById('shiftCount').value     = shift?.requiredCount || '';
    this.loadDeptOptions('shiftDept','shiftHospital', shift?.department);
    document.getElementById('shiftModalTitle').textContent = shift ? 'تعديل جدول الدوام' : 'إضافة جدول دوام';
    this.openModal('shiftModal');
  },

  editShift(id) {
    const s = DB.getShifts().find(x => x.id === id);
    if (s) this.openShiftModal(s);
  },

  saveShift() {
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
    if (id) DB.updateShift(id, data);
    else    DB.addShift(data);

    Toast.show(id ? 'تم تحديث جدول الدوام' : 'تمت إضافة جدول الدوام', 'success');
    this.closeModal('shiftModal');
    this.renderShifts();
  },

  deleteShift(id) {
    this._confirm('هل تريد حذف هذا الجدول؟', () => {
      DB.deleteShift(id);
      Toast.show('تم حذف الجدول', 'success');
      this.renderShifts();
    });
  },

  /* ====== أقسام ====== */
  renderDepts() {
    const depts = DB.getDepartments();
    const tbody = document.getElementById('deptsBody');
    if (!tbody) return;
    if (!depts.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><i class="fas fa-sitemap"></i><p>لم يتم إضافة أقسام بعد</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = depts.map((d, i) => `
      <tr>
        <td>${i+1}</td>
        <td><strong>${esc(d.name)}</strong></td>
        <td>${esc(d.hospital)}</td>
        <td style="font-size:13px;color:var(--text-muted)">${DB.formatDate(d.createdAt)}</td>
        <td><button class="btn btn-danger btn-sm btn-icon" onclick="AdminApp.deleteDept('${esc(d.id)}')"><i class="fas fa-trash"></i></button></td>
      </tr>`).join('');
  },

  openDeptModal() { this.openModal('deptModal'); document.getElementById('deptName').value = ''; document.getElementById('deptHospital').value = ''; },

  saveDept() {
    const name = document.getElementById('deptName').value.trim();
    const hospital = document.getElementById('deptHospital').value;
    if (!name) return Toast.show('يرجى إدخال اسم القسم', 'error');
    if (!hospital) return Toast.show('يرجى اختيار المستشفى', 'error');
    DB.addDepartment({ name, hospital });
    Toast.show('تمت إضافة القسم بنجاح', 'success');
    this.closeModal('deptModal');
    this.renderDepts();
  },

  deleteDept(id, name) {
    name = name || DB.getDepartments().find(d => d.id === id)?.name || '';
    this._confirm(`هل تريد حذف قسم "${name}"؟`, () => {
      DB.deleteDepartment(id);
      Toast.show('تم حذف القسم', 'success');
      this.renderDepts();
    });
  },

  /* ====== تحميل خيارات الأقسام ====== */
  loadDeptOptions(targetId, hospitalSelectId, selected) {
    const hospital = document.getElementById(hospitalSelectId)?.value;
    const select = document.getElementById(targetId);
    if (!select) return;
    select.innerHTML = '<option value="">-- اختر القسم --</option>';
    if (hospital) {
      DB.getDeptsByHospital(hospital).forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name; opt.textContent = d.name;
        if (selected && d.name === selected) opt.selected = true;
        select.appendChild(opt);
      });
    }
  },

  /* ====== سجل التقارير ====== */
  renderReports() {
    const filterDate    = document.getElementById('repFilterDate')?.value    || '';
    const filterHosp    = document.getElementById('repFilterHospital')?.value || '';
    const filterPeriod  = document.getElementById('repFilterPeriod')?.value  || '';
    const filterStatus  = document.getElementById('repFilterStatus')?.value  || '';
    const filterSearch  = (document.getElementById('repFilterSearch')?.value || '').toLowerCase();

    let reports = DB.getReports();
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
        <td>${esc(r.date)}</td>
        <td>${esc(r.day) || DB.getDayName(r.date)}</td>
        <td style="font-size:13px">${esc(r.hospital) || '-'}</td>
        <td>${esc(r.department) || '-'}</td>
        <td><span class="badge badge-info">${esc(r.period) || '-'}</span></td>
        <td>${r.total || 0}</td>
        <td><span style="color:var(--success);font-weight:700">${r.present || 0}</span></td>
        <td><span style="color:var(--danger);font-weight:700">${r.absent || 0}</span></td>
        <td>${r.withdrawn || 0}</td>
        <td>${r.leave || 0}</td>
        <td>${esc(r.enteredBy) || '-'}</td>
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

    this._updatePendingBadge();
  },

  resetRepFilter() {
    ['repFilterDate','repFilterHospital','repFilterPeriod','repFilterStatus','repFilterSearch'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    this.renderReports();
  },

  async approveReport(id) {
    const s = DB.getSettings();
    if (!s.deputyName) Toast.show('تنبيه: لم يتم إعداد اسم النائب الإداري — سيُعتمد التقرير بدون توقيع (الإعدادات ← توقيع الاعتماد)', 'warning', 5000);
    const rec = DB.approveReport(id);
    if (!rec) return;
    // تحديث فوري للواجهة: الشارة تتغير إلى "معتمد" وزرا ✓/✗ يختفيان دون تحديث الصفحة
    this.renderReports();
    this._updatePendingBadge();
    this.renderAlerts();
    // الحفظ في Supabase بانتظار النتيجة الفعلية
    const res = await Sync.pushReportApproval(rec);
    if (!res.ok) {
      console.error('[اعتماد التقرير] فشل الحفظ في Supabase — التقرير:', id, '— الخطأ:', res.error);
      Toast.show('فشل حفظ الاعتماد في قاعدة البيانات: ' + (res.error?.message || 'خطأ غير معروف') + ' — قد تعود الحالة إلى "بانتظار الاعتماد" عند المزامنة', 'error', 8000);
      return;
    }
    if (res.queued)     Toast.show('تم الاعتماد محلياً — سيُحفظ في السحابة تلقائياً عند عودة الاتصال', 'warning', 5000);
    else if (res.local) Toast.show('تم اعتماد التقرير' + (s.deputySignature ? ' وختمه بتوقيع النائب الإداري' : ''), 'success');
    else                Toast.show('تم اعتماد التقرير وحفظه في قاعدة البيانات' + (s.deputySignature ? ' وختمه بتوقيع النائب الإداري' : ''), 'success');
  },

  openRejectModal(id) {
    document.getElementById('rejectReportId').value = id;
    document.getElementById('rejectReason').value = '';
    this.openModal('rejectModal');
  },

  confirmReject() {
    const id = document.getElementById('rejectReportId').value;
    const reason = document.getElementById('rejectReason').value.trim();
    if (!reason) return Toast.show('يرجى كتابة سبب الرفض', 'error');
    DB.rejectReport(id, reason);
    Toast.show('تم رفض التقرير', 'warning');
    this.closeModal('rejectModal');
    this.renderReports();
    this._updatePendingBadge();
    this.renderAlerts();
  },

  viewReport(id) {
    const r = DB.getReports().find(x => x.id === id);
    if (!r) return;
    const body = document.getElementById('reportDetailBody');
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        ${this._detailRow('التاريخ', esc(r.date))}
        ${this._detailRow('اليوم', esc(r.day) || DB.getDayName(r.date))}
        ${this._detailRow('الفترة', `<span class="badge badge-info">${esc(r.period)||'-'}</span>`)}
        ${this._detailRow('المستشفى', esc(r.hospital)||'-')}
        ${this._detailRow('القسم', esc(r.department)||'-')}
        ${this._detailRow('الحالة', this._statusBadge(r.status))}
        ${this._detailRow('إجمالي الموظفين', `<strong>${r.total||0}</strong>`)}
        ${this._detailRow('الحضور', `<span style="color:var(--success);font-weight:700">${r.present||0}</span>`)}
        ${this._detailRow('الغياب', `<span style="color:var(--danger);font-weight:700">${r.absent||0}</span>`)}
        ${this._detailRow('الانسحاب', r.withdrawn||0)}
        ${this._detailRow('في إجازة', r.leave||0)}
        ${this._detailRow('مدخل البيانات', esc(r.enteredBy)||'-')}
      </div>
      ${r.absentNames ? `<div style="margin-top:16px"><strong>أسماء المتغيبين:</strong><div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-top:8px;white-space:pre-wrap;font-size:14px">${esc(r.absentNames)}</div></div>` : ''}
      ${r.notes ? `<div style="margin-top:16px"><strong>الملاحظات:</strong><div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-top:8px;white-space:pre-wrap;font-size:14px">${esc(r.notes)}</div></div>` : ''}
      ${r.status==='rejected' && r.rejectionReason ? `<div style="margin-top:16px;background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:8px;padding:14px"><strong style="color:var(--danger)"><i class="fas fa-ban"></i> سبب الرفض:</strong><p style="margin-top:6px;font-size:14px">${esc(r.rejectionReason)}</p></div>` : ''}
      ${r.status==='approved' ? `
        <div class="signature-block" style="margin-top:20px">
          <div style="font-weight:700;color:var(--success);margin-bottom:8px"><i class="fas fa-file-signature"></i> اعتماد النائب الإداري</div>
          ${DB.resolveSignature(r) ? `<img src="${DB.resolveSignature(r)}" alt="التوقيع" style="max-height:70px;display:block;margin-bottom:6px">` : ''}
          <div style="font-size:14px;font-weight:700">${esc(r.approvedBy) || 'النائب الإداري'}</div>
          <div style="font-size:12px;color:var(--text-muted)">${esc(r.approverTitle) || 'النائب الإداري'} — ${DB.formatDate(r.approvedAt)}</div>
        </div>` : ''}
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
    this._confirm('هل تريد حذف هذا التقرير نهائياً؟', () => {
      DB.deleteReport(id);
      Toast.show('تم حذف التقرير', 'success');
      this.renderReports();
      this._updatePendingBadge();
    });
  },

  clearReports() {
    this._confirm('سيتم حذف جميع التقارير نهائياً. هل أنت متأكد؟', () => {
      DB.clearReports();
      Toast.show('تم حذف جميع التقارير', 'success');
      this._updatePendingBadge();
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
              <td>${esc(r.date)}</td>
              <td>${esc(r.day)||DB.getDayName(r.date)}</td>
              <td style="font-size:12.5px">${esc(r.hospital)||'-'}</td>
              <td>${esc(r.department)||'-'}</td>
              <td><span class="badge badge-info" style="font-size:11px">${esc(r.period)||'-'}</span></td>
              <td>${r.total||0}</td>
              <td><span style="color:var(--success);font-weight:700">${r.present||0}</span></td>
              <td><span style="color:var(--danger);font-weight:700">${r.absent||0}</span></td>
              <td>${r.withdrawn||0}</td>
              <td>${r.leave||0}</td>
              <td style="font-size:12px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.absentNames)}">${esc(r.absentNames)||'-'}</td>
              <td style="font-size:12px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.notes)}">${esc(r.notes)||'-'}</td>
              <td>${esc(r.enteredBy)||'-'}</td>
              <td>${this._statusBadge(r.status)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  },

  renderDailyReport() {
    const date = document.getElementById('dailyDate')?.value;
    const body = document.getElementById('dailyReportBody');
    if (!body) return;
    const reports = DB.getReports().filter(r => r.date === date);
    body.innerHTML = this._buildReportTable(reports);
  },

  renderWeeklyReport() {
    const from = document.getElementById('weeklyFrom')?.value;
    const to   = document.getElementById('weeklyTo')?.value;
    const body = document.getElementById('weeklyReportBody');
    if (!body) return;
    const reports = DB.getReports().filter(r => (!from || r.date >= from) && (!to || r.date <= to));
    body.innerHTML = this._buildReportTable(reports);
  },

  renderMonthlyReport() {
    const month = document.getElementById('monthlyMonth')?.value;
    const body = document.getElementById('monthlyReportBody');
    if (!body) return;
    const reports = DB.getReports().filter(r => month && r.date.startsWith(month));
    body.innerHTML = this._buildReportTable(reports);
  },

  /* ====== تصدير Excel ====== */
  exportReports(type) {
    let reports = DB.getReports();
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
      const csv = '﻿' + [headers, ...rows.map(r => headers.map(h => `"${(r[h] ?? '').toString().replace(/"/g,'""')}"`))].map(r => r.join(',')).join('\n');
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
    if (newP.length < 6) return Toast.show('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل', 'error');
    if (newP !== conP) return Toast.show('كلمتا المرور غير متطابقتين', 'error');

    if (Cloud.on()) {
      // تحقق من القديمة بمحاولة دخول، ثم حدّث في Supabase Auth
      try {
        const { error: e1 } = await Cloud.sb.auth.signInWithPassword({ email: SUPABASE_CONFIG.adminEmail, password: oldP });
        if (e1) return Toast.show('كلمة المرور الحالية غير صحيحة', 'error');
        const { error: e2 } = await Cloud.sb.auth.updateUser({ password: newP });
        if (e2) return Toast.show('تعذر تغيير كلمة المرور — حاول مجدداً', 'error');
      } catch { return Toast.show('تعذر الاتصال بالخادم — حاول مجدداً', 'error'); }
    } else {
      if (!(await DB.verifyPass(oldP))) return Toast.show('كلمة المرور الحالية غير صحيحة', 'error');
      await DB.setPassHashed(newP);
    }
    DB.audit('تغيير كلمة المرور', 'تم تغيير كلمة مرور المسؤول');
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

    // جلب قائمة الأقسام المحدثة من السحابة (قراءة عامة غير حساسة)
    Sync.pullDepartments();

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
    const finish = emp => {
      err.classList.remove('show');
      this.currentEmployee = emp;
      DB.setEmpSession(emp);
      this._showForm();
    };

    if (Cloud.on() && navigator.onLine !== false) {
      // التحقق من الخادم عبر RPC — لا يكشف جدول الموظفين، يعيد الاسم فقط
      try {
        const { data, error } = await Cloud.sb.rpc('verify_employee_code', { p_code: code });
        if (!error) {
          if (Array.isArray(data) && data.length) return finish({ name: data[0].name, hospital: data[0].hospital || '', code });
          err.classList.add('show');
          return;
        }
      } catch { /* خطأ اتصال — نجرب النسخة المحلية */ }
    }

    const emp = DB.findByCode(code);
    if (emp) finish(emp);
    else err.classList.add('show');
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
      DB.getDeptsByHospital(hospital).forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name; opt.textContent = d.name;
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

  submitReport() {
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

    // منع التقارير المكررة لنفس (التاريخ/المستشفى/القسم/الفترة) — المرفوضة تُستثنى للسماح بإعادة الإدخال
    const duplicate = DB.getReports().some(r =>
      r.date === date && r.hospital === hospital && r.department === dept &&
      r.period === period && r.status !== 'rejected'
    );
    if (duplicate) return Toast.show('يوجد تقرير مسجل مسبقاً لهذا القسم في نفس التاريخ والفترة. راجع النائب الإداري إن كان هناك خطأ.', 'error', 6000);

    const report = DB.addReport({ date, day, period, hospital, department: dept, total, present, absent, withdrawn, leave, absentNames, notes, enteredBy, employeeCode: this.currentEmployee.code });
    // الإرسال للسحابة عبر RPC (يتحقق الخادم من الكود ويمنع التكرار) — يُعاد تلقائياً عند انقطاع الاتصال
    Sync.queueSubmit(report, this.currentEmployee.code);

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
   الوضع الليلي (متاح في جميع الصفحات)
   ====================================================== */
const Theme = {
  apply() {
    const t = localStorage.getItem(DB._k.theme) || 'light';
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('.theme-toggle i').forEach(i => {
      i.className = t === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    });
  },
  toggle() {
    const cur = localStorage.getItem(DB._k.theme) || 'light';
    localStorage.setItem(DB._k.theme, cur === 'dark' ? 'light' : 'dark');
    this.apply();
  },
};

/* ======================================================
   ميزات إضافية للوحة المسؤول:
   التنبيهات، سجل التدقيق، النسخ الاحتياطي، توقيع النائب
   الإداري، الطباعة/PDF
   ====================================================== */
Object.assign(AdminApp, {

  /* ====== التنبيهات الذكية ====== */
  _buildAlerts() {
    const alerts = [];
    const today = DB.today();
    const reports = DB.getReports();

    const pending = reports.filter(r => r.status === 'pending').length;
    if (pending > 0) alerts.push({ type: 'pending', icon: 'fa-clock', level: 'warning', text: `${pending} تقرير بانتظار الاعتماد`, action: 'reports' });

    // جداول دوام بلا تقرير اليوم
    const todayReps = reports.filter(r => r.date === today);
    const uncovered = DB.getShifts().filter(s =>
      !todayReps.some(r => r.hospital === s.hospital && r.department === s.department && r.period === s.period)
    );
    if (uncovered.length) {
      const preview = uncovered.slice(0, 3).map(s => `${esc(s.department)} (${esc(s.period)})`).join('، ');
      alerts.push({ type: 'uncovered', icon: 'fa-calendar-xmark', level: 'danger',
        text: `${uncovered.length} جدول دوام بلا تقرير اليوم: ${preview}${uncovered.length > 3 ? '…' : ''}`, action: 'shifts' });
    }

    // نقص حرج في التغطية اليوم
    const shifts = DB.getShifts();
    let critical = 0;
    todayReps.forEach(r => {
      const s = shifts.find(x => x.hospital === r.hospital && x.department === r.department && x.period === r.period);
      if (s && +s.requiredCount > 0 && (+r.present || 0) < +s.requiredCount * 0.7) critical++;
    });
    if (critical) alerts.push({ type: 'critical', icon: 'fa-triangle-exclamation', level: 'danger', text: `${critical} قسم بنقص حرج في التغطية اليوم (أقل من 70%)`, action: 'analytics' });

    // لا يوجد توقيع للنائب الإداري
    const s = DB.getSettings();
    if (!s.deputyName || !s.deputySignature) {
      alerts.push({ type: 'signature', icon: 'fa-file-signature', level: 'info', text: 'لم يتم إعداد اسم وتوقيع النائب الإداري بعد — أضفه من الإعدادات', action: 'settings' });
    }
    return alerts;
  },

  renderAlerts() {
    const alerts = this._buildAlerts();
    // شارة الجرس
    const bell = document.getElementById('notifCount');
    if (bell) {
      const n = alerts.filter(a => a.level !== 'info').length;
      bell.style.display = n ? 'flex' : 'none';
      bell.textContent = n;
    }
    // القائمة المنسدلة
    const list = document.getElementById('notifList');
    if (list) {
      list.innerHTML = alerts.length
        ? alerts.map(a => `
          <div class="notif-item notif-${a.level}" onclick="AdminApp.showSection('${a.action}');AdminApp.closeNotif()">
            <i class="fas ${a.icon}"></i><span>${a.text}</span>
          </div>`).join('')
        : `<div class="notif-empty"><i class="fas fa-check-circle"></i> لا توجد تنبيهات — كل شيء على ما يرام</div>`;
    }
    // لوحة التنبيهات في لوحة التحكم
    const panel = document.getElementById('alertsPanel');
    if (panel) {
      const important = alerts.filter(a => a.level !== 'info');
      panel.style.display = important.length ? 'block' : 'none';
      panel.innerHTML = important.map(a => `
        <div class="alert-row alert-${a.level}" onclick="AdminApp.showSection('${a.action}')">
          <i class="fas ${a.icon}"></i><span>${a.text}</span><i class="fas fa-chevron-left" style="margin-right:auto;opacity:.5"></i>
        </div>`).join('');
    }
  },

  toggleNotif() {
    this.renderAlerts();
    document.getElementById('notifDropdown')?.classList.toggle('open');
  },
  closeNotif() { document.getElementById('notifDropdown')?.classList.remove('open'); },

  /* ====== سجل التدقيق ====== */
  renderAudit() {
    const search = (document.getElementById('auditSearch')?.value || '').toLowerCase();
    let log = DB.getAudit();
    if (search) log = log.filter(l => (l.action + ' ' + l.details).toLowerCase().includes(search));
    const tbody = document.getElementById('auditBody');
    if (!tbody) return;
    const countEl = document.getElementById('auditCount');
    if (countEl) countEl.textContent = `(${log.length} حدث)`;
    if (!log.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><i class="fas fa-clipboard-check"></i><p>لا توجد أحداث مسجلة</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = log.map((l, i) => {
      const d = new Date(l.at);
      return `<tr>
        <td>${i + 1}</td>
        <td style="white-space:nowrap;font-size:12.5px">${d.toLocaleDateString('ar-SA')} ${d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}</td>
        <td><span class="badge badge-info">${esc(l.action)}</span></td>
        <td style="font-size:13px">${esc(l.details) || '-'}</td>
      </tr>`;
    }).join('');
  },

  clearAuditLog() {
    this._confirm('سيتم حذف سجل التدقيق بالكامل. هل أنت متأكد؟', () => {
      DB.clearAudit();
      Toast.show('تم مسح سجل التدقيق', 'success');
      this.renderAudit();
    });
  },

  exportAudit() {
    const log = DB.getAudit();
    if (!log.length) return Toast.show('لا توجد أحداث للتصدير', 'warning');
    const rows = log.map((l, i) => ({
      '#': i + 1,
      'التاريخ والوقت': new Date(l.at).toLocaleString('ar-SA'),
      'الحدث': l.action,
      'التفاصيل': l.details || '',
    }));
    if (typeof XLSX === 'undefined') return Toast.show('تعذر تحميل مكتبة التصدير', 'error');
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 5 }, { wch: 22 }, { wch: 20 }, { wch: 60 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'سجل التدقيق');
    XLSX.writeFile(wb, `سجل_التدقيق_${DB.today()}.xlsx`);
    Toast.show('تم تصدير سجل التدقيق', 'success');
  },

  /* ====== النسخ الاحتياطي والاستعادة ====== */
  backupData() {
    const data = {
      _meta: { app: 'mksh-attendance', version: 2, exportedAt: DB._now() },
      employees:   DB.getEmployees(),
      departments: DB.getDepartments(),
      shifts:      DB.getShifts(),
      reports:     DB.getReports(),
      settings:    DB.getSettings(),
      audit:       DB.getAudit(),
      signatures:  DB.getSignaturesReg(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `نسخة_احتياطية_منصة_الدوام_${DB.today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    DB.audit('نسخ احتياطي', 'تم تنزيل نسخة احتياطية كاملة');
    Toast.show('تم تنزيل النسخة الاحتياطية', 'success');
  },

  restoreData(input) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data._meta || data._meta.app !== 'mksh-attendance') {
          return Toast.show('الملف ليس نسخة احتياطية صالحة لهذه المنصة', 'error');
        }
        this._confirm('سيتم استبدال جميع البيانات الحالية بمحتوى النسخة الاحتياطية. هل أنت متأكد؟', () => {
          if (Array.isArray(data.employees))   DB._set(DB._k.emps, data.employees);
          if (Array.isArray(data.departments)) DB._set(DB._k.depts, data.departments);
          if (Array.isArray(data.shifts))      DB._set(DB._k.shifts, data.shifts);
          if (Array.isArray(data.reports))     DB._set(DB._k.reports, data.reports);
          if (data.settings)                   DB._set(DB._k.settings, data.settings);
          if (Array.isArray(data.audit))       DB._set(DB._k.audit, data.audit);
          if (data.signatures)                 DB._set(DB._k.sigs, data.signatures);
          DB.migrateSignatures(); // دعم النسخ القديمة ذات التوقيعات المضمّنة
          DB.audit('استعادة نسخة احتياطية', `من ملف: ${file.name}`);
          Toast.show('تمت الاستعادة بنجاح', 'success');
          this.showSection('dashboard');
          this.renderAlerts();
          this._updatePendingBadge();
        });
      } catch {
        Toast.show('تعذر قراءة الملف — تأكد أنه ملف JSON صالح', 'error');
      }
      input.value = '';
    };
    reader.readAsText(file);
  },

  /* ====== توقيع النائب الإداري ====== */
  _sigPad: { drawing: false, dirty: false },

  loadSettingsUI() {
    const s = DB.getSettings();
    const nameEl  = document.getElementById('deputyName');
    const titleEl = document.getElementById('deputyTitle');
    if (nameEl)  nameEl.value  = s.deputyName  || '';
    if (titleEl) titleEl.value = s.deputyTitle || '';
    const preview = document.getElementById('sigPreview');
    if (preview) {
      preview.innerHTML = s.deputySignature
        ? `<img src="${s.deputySignature}" alt="التوقيع المحفوظ" style="max-height:60px">`
        : `<span style="color:var(--text-muted);font-size:13px">لا يوجد توقيع محفوظ</span>`;
    }
    this.initSignaturePad();
  },

  initSignaturePad() {
    const canvas = document.getElementById('sigCanvas');
    if (!canvas || canvas._sigInit) return;
    canvas._sigInit = true;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pos = e => {
      const rect = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return {
        x: (p.clientX - rect.left) * (canvas.width / rect.width),
        y: (p.clientY - rect.top) * (canvas.height / rect.height),
      };
    };
    const start = e => {
      e.preventDefault();
      this._sigPad.drawing = true;
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#1a3a5c';
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    };
    const move = e => {
      if (!this._sigPad.drawing) return;
      e.preventDefault();
      const p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      this._sigPad.dirty = true;
    };
    const end = () => { this._sigPad.drawing = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
  },

  clearSignature() {
    const canvas = document.getElementById('sigCanvas');
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    this._sigPad.dirty = false;
  },

  saveDeputyInfo() {
    const name  = document.getElementById('deputyName')?.value.trim();
    const title = document.getElementById('deputyTitle')?.value.trim() || 'النائب الإداري';
    if (!name) return Toast.show('يرجى إدخال اسم النائب الإداري', 'error');
    const patch = { deputyName: name, deputyTitle: title };
    if (this._sigPad.dirty) {
      const canvas = document.getElementById('sigCanvas');
      if (canvas) patch.deputySignature = canvas.toDataURL('image/png');
    }
    DB.saveSettings(patch);
    DB.audit('تحديث بيانات النائب الإداري', `${name} — ${title}${patch.deputySignature ? ' (مع توقيع جديد)' : ''}`);
    Toast.show('تم حفظ بيانات النائب الإداري والتوقيع', 'success');
    this._sigPad.dirty = false;
    this.loadSettingsUI();
    this.renderAlerts();
  },

  /* ====== طباعة / PDF للتقارير الدورية ====== */
  printReport(type) {
    let reports = DB.getReports();
    let periodLabel = '';

    if (type === 'daily') {
      const date = document.getElementById('dailyDate')?.value;
      reports = reports.filter(r => r.date === date);
      periodLabel = `التقرير اليومي — ${date} (${DB.getDayName(date)})`;
    } else if (type === 'weekly') {
      const from = document.getElementById('weeklyFrom')?.value;
      const to   = document.getElementById('weeklyTo')?.value;
      reports = reports.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
      periodLabel = `التقرير الأسبوعي — من ${from} إلى ${to}`;
    } else if (type === 'monthly') {
      const month = document.getElementById('monthlyMonth')?.value;
      reports = reports.filter(r => month && r.date.startsWith(month));
      periodLabel = `التقرير الشهري — ${month}`;
    }

    if (!reports.length) return Toast.show('لا توجد تقارير في هذه الفترة للطباعة', 'warning');

    const totals = reports.reduce((a, r) => {
      a.total += +r.total || 0; a.present += +r.present || 0; a.absent += +r.absent || 0;
      a.withdrawn += +r.withdrawn || 0; a.leave += +r.leave || 0; return a;
    }, { total: 0, present: 0, absent: 0, withdrawn: 0, leave: 0 });

    const statusMap = { pending: 'بانتظار الاعتماد', approved: 'معتمد', rejected: 'مرفوض' };
    const rowsHtml = reports.map((r, i) => `
      <tr>
        <td>${i + 1}</td><td>${esc(r.date)}</td><td>${esc(r.day) || DB.getDayName(r.date)}</td>
        <td>${esc(r.hospital) || '-'}</td><td>${esc(r.department) || '-'}</td><td>${esc(r.period) || '-'}</td>
        <td>${r.total || 0}</td><td>${r.present || 0}</td><td>${r.absent || 0}</td>
        <td>${r.withdrawn || 0}</td><td>${r.leave || 0}</td>
        <td>${esc(r.enteredBy) || '-'}</td><td>${statusMap[r.status] || esc(r.status)}</td>
      </tr>`).join('');

    const s = DB.getSettings();
    const sigHtml = `
      <div class="sig-section">
        <div class="sig-box">
          <div class="sig-label">اعتماد النائب الإداري</div>
          ${s.deputySignature ? `<img src="${s.deputySignature}" class="sig-img" alt="التوقيع">` : '<div class="sig-line"></div>'}
          <div class="sig-name">${esc(s.deputyName) || '..............................'}</div>
          <div class="sig-title">${esc(s.deputyTitle) || 'النائب الإداري'}</div>
        </div>
        <div class="sig-box">
          <div class="sig-label">التاريخ</div>
          <div class="sig-line"></div>
          <div class="sig-name">${new Date().toLocaleDateString('ar-SA')}</div>
        </div>
      </div>`;

    const win = window.open('', '_blank', 'width=1000,height=750');
    if (!win) return Toast.show('يرجى السماح بالنوافذ المنبثقة لإتاحة الطباعة', 'warning');
    win.document.write(`<!DOCTYPE html>
      <html lang="ar" dir="rtl"><head><meta charset="UTF-8">
      <title>${periodLabel}</title>
      <style>
        body{font-family:Tahoma,Arial,sans-serif;padding:28px;color:#1e2d3d;font-size:13px}
        .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1a3a5c;padding-bottom:12px;margin-bottom:6px}
        h1{font-size:18px;color:#1a3a5c}
        .sub{color:#5a6a7e;font-size:12px}
        .totals{display:flex;gap:14px;margin:14px 0;flex-wrap:wrap}
        .tot{border:1px solid #d5dde8;border-radius:8px;padding:8px 16px;text-align:center}
        .tot b{display:block;font-size:17px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th,td{border:1px solid #c9d4e0;padding:6px 8px;text-align:center}
        th{background:#f0f4f9}
        .sig-section{display:flex;justify-content:space-between;margin-top:48px;page-break-inside:avoid}
        .sig-box{text-align:center;min-width:220px}
        .sig-label{font-weight:700;font-size:13px;margin-bottom:14px}
        .sig-img{max-height:65px;margin-bottom:6px}
        .sig-line{border-bottom:1.5px dotted #8a9ab0;height:40px;margin-bottom:8px}
        .sig-name{font-weight:700;font-size:14px}
        .sig-title{color:#5a6a7e;font-size:12px}
        @media print { body{padding:10mm} }
      </style></head>
      <body>
        <div class="head">
          <div>
            <h1>منصة مراقبة الدوام — مدينة الملك سلمان الطبية</h1>
            <div class="sub">${periodLabel}</div>
          </div>
          <div class="sub">تاريخ الإصدار: ${new Date().toLocaleString('ar-SA')}</div>
        </div>
        <div class="totals">
          <div class="tot"><b>${totals.total}</b>إجمالي الموظفين</div>
          <div class="tot"><b>${totals.present}</b>الحضور</div>
          <div class="tot"><b>${totals.absent}</b>الغياب</div>
          <div class="tot"><b>${totals.withdrawn}</b>الانسحاب</div>
          <div class="tot"><b>${totals.leave}</b>الإجازات</div>
          <div class="tot"><b>${reports.length}</b>عدد التقارير</div>
        </div>
        <table>
          <thead><tr>
            <th>#</th><th>التاريخ</th><th>اليوم</th><th>المستشفى</th><th>القسم</th><th>الفترة</th>
            <th>إجمالي</th><th>حضور</th><th>غياب</th><th>انسحاب</th><th>إجازة</th><th>مدخل البيانات</th><th>الحالة</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${sigHtml}
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
    DB.audit('طباعة تقرير', periodLabel);
  },
});

/* ======================================================
   تهيئة عند تحميل الصفحة
   ====================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;

  Cloud.init(); // تهيئة الاتصال بـ Supabase (لا يفعل شيئاً إن لم يُضبط config.js)
  Theme.apply();

  // تسجيل Service Worker (يعمل على GitHub Pages وأي خادم HTTPS)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // إغلاق المودالات بالضغط خارجها
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) m.classList.remove('open');
    });
  });

  // إغلاق قائمة التنبيهات بالضغط خارجها
  document.addEventListener('click', e => {
    const wrap = document.getElementById('notifWrap');
    if (wrap && !wrap.contains(e.target)) AdminApp.closeNotif?.();
  });

  if (page === 'admin')    AdminApp.init();
  if (page === 'employee') EmployeeApp.init();
});
