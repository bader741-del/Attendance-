/* ============================================================
   منصة مراقبة الدوام - مدينة الملك سلمان الطبية
   approvals.js — صفحة اعتماد الجولات (مدير المناوبة / المدير العام)
   ------------------------------------------------------------
   كل القراءة والكتابة تتم من Supabase مباشرة (لا localStorage):
   - مدير المناوبة: عبر دوال RPC (security definer) بعد التحقق من كوده
   - المدير العام: جلسة Supabase Auth + سياسات RLS الحالية
   ============================================================ */

'use strict';

const ApprovalsApp = {
  MGR_SESSION_KEY: 'mksh_mgr_session', // sessionStorage (جلسة متصفح فقط — ليست localStorage)
  mode: null,          // 'manager' | 'admin'
  managerName: '',
  managerCode: '',
  rounds: [],          // الجولات من قاعدة البيانات
  statusFilter: 'pending',
  _timer: null,
  _sigPad: { drawing: false, dirty: false },

  /* ================= تهيئة ================= */
  async init() {
    if (!Cloud.on()) {
      document.getElementById('apvLogin').style.display = 'flex';
      Toast.show('صفحة اعتماد الجولات تتطلب ربط Supabase — أدخل بيانات المشروع في config.js', 'error', 8000);
      return;
    }

    // جلسة مدير مناوبة محفوظة في هذه النافذة؟
    const saved = this._getMgrSession();
    if (saved?.code) {
      const name = await this._verifyManager(saved.code);
      if (name) return this._enter('manager', name, saved.code);
      this._clearMgrSession();
    }

    // جلسة المدير العام (Supabase Auth) سارية؟
    try {
      const { data } = await Cloud.sb.auth.getSession();
      if (data?.session) {
        const { data: adm } = await Cloud.sb.from('admin_users').select('user_id').maybeSingle();
        if (adm) return this._enter('admin', 'المدير العام');
      }
    } catch { /* لا جلسة — نعرض شاشة الدخول */ }

    document.getElementById('apvLogin').style.display = 'flex';
    const inp = document.getElementById('apvCodeInput');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });
  },

  _getMgrSession()  { try { const v = sessionStorage.getItem(this.MGR_SESSION_KEY); return v ? JSON.parse(v) : null; } catch { return null; } },
  _setMgrSession(s) { sessionStorage.setItem(this.MGR_SESSION_KEY, JSON.stringify(s)); },
  _clearMgrSession(){ sessionStorage.removeItem(this.MGR_SESSION_KEY); },

  async _verifyManager(code) {
    try {
      const { data, error } = await Cloud.sb.rpc('verify_manager_code', { p_code: code });
      if (error) { console.error('[اعتماد الجولات] فشل التحقق من كود مدير المناوبة:', error); return null; }
      return (Array.isArray(data) && data.length) ? data[0].name : null;
    } catch (e) { console.error('[اعتماد الجولات] خطأ اتصال أثناء التحقق:', e); return null; }
  },

  async login() {
    const inp = document.getElementById('apvCodeInput');
    const err = document.getElementById('apvLoginError');
    const code = (inp?.value || '').trim().toUpperCase();
    if (!code) return;
    const name = await this._verifyManager(code);
    if (!name) { err.classList.add('show'); inp.value = ''; inp.focus(); return; }
    err.classList.remove('show');
    this._setMgrSession({ code, name });
    this._enter('manager', name, code);
  },

  logout() {
    this._clearMgrSession();
    if (this._timer) clearInterval(this._timer);
    location.href = 'index.html';
  },

  _enter(mode, name, code = '') {
    this.mode = mode;
    this.managerName = name;
    this.managerCode = code;
    document.getElementById('apvLogin').style.display = 'none';
    document.getElementById('apvContent').style.display = 'block';
    document.getElementById('apvUserName').textContent =
      mode === 'admin' ? 'المدير العام' : `مدير المناوبة: ${name}`;
    this.setStatusFilter('pending');
    this.reload();
    if (!this._timer) this._timer = setInterval(() => this.reload(true), 60000);
  },

  /* ================= جلب البيانات من Supabase ================= */
  async reload(silent = false) {
    try {
      let rows, error;
      if (this.mode === 'admin') {
        ({ data: rows, error } = await Cloud.sb.from('reports').select('*').order('created_at', { ascending: false }));
      } else {
        ({ data: rows, error } = await Cloud.sb.rpc('manager_list_reports', { p_code: this.managerCode }));
      }
      if (error) {
        console.error('[اعتماد الجولات] فشل تحميل الجولات:', error);
        if (!silent) Toast.show('فشل تحميل الجولات من قاعدة البيانات: ' + (error.message || ''), 'error', 6000);
        return;
      }
      this.rounds = (rows || []).map(r => this._fromCloud(r));
      this.render();
    } catch (e) {
      console.error('[اعتماد الجولات] خطأ اتصال:', e);
      if (!silent) Toast.show('تعذر الاتصال بقاعدة البيانات — تحقق من الشبكة', 'error');
    }
  },

  _fromCloud(row) {
    return {
      id: row.client_id || row.id,
      date: row.date, day: row.day, period: row.period,
      hospital: row.hospital, department: row.department,
      total: row.total, present: row.present, absent: row.absent,
      withdrawn: row.withdrawn, leave: row.leave_count,
      absentNames: row.absent_names, notes: row.notes,
      enteredBy: row.entered_by, employeeCode: row.employee_code,
      status: row.status, rejectionReason: row.rejection_reason || row.rejected_reason,
      approvedBy: row.approved_by, approverTitle: row.approver_title,
      approvedAt: row.approved_at, rejectedAt: row.rejected_at,
      approvalSignature: row.approval_signature,
      returnedForEdit: !!row.returned_for_edit, returnNote: row.return_note,
      approvedDate: row.approved_date, approvedTime: row.approved_time,
      createdAt: row.created_at,
    };
  },

  /* رقم جولة قصير ثابت مشتق من المعرّف */
  roundNo(r) {
    const src = String(r.id || '');
    return 'R-' + src.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
  },

  _fmtDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleDateString('ar-SA') + ' ' + d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
  },

  _badge(r) {
    if (r.status === 'approved') return `<span class="badge round-badge-approved"><i class="fas fa-check-circle"></i> معتمدة</span>`;
    if (r.status === 'rejected') return `<span class="badge round-badge-rejected"><i class="fas fa-ban"></i> مرفوضة</span>`;
    return `<span class="badge round-badge-pending"><i class="fas fa-clock"></i> بانتظار الاعتماد</span>`;
  },

  /* ================= العرض ================= */
  setStatusFilter(s) {
    this.statusFilter = s;
    ['pending','approved','rejected'].forEach(k =>
      document.getElementById(`apvCard-${k}`)?.classList.toggle('active', s === k));
    document.getElementById('apvCard-all')?.classList.toggle('active', s === '');
    this.render();
  },

  resetFilters() {
    ['apvFilterDate','apvFilterHospital','apvFilterPeriod','apvFilterSearch'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    this.setStatusFilter('pending');
  },

  _filtered() {
    const date   = document.getElementById('apvFilterDate')?.value || '';
    const hosp   = document.getElementById('apvFilterHospital')?.value || '';
    const period = document.getElementById('apvFilterPeriod')?.value || '';
    const search = (document.getElementById('apvFilterSearch')?.value || '').toLowerCase();
    let list = this.rounds;
    if (this.statusFilter) list = list.filter(r => r.status === this.statusFilter);
    if (date)   list = list.filter(r => r.date === date);
    if (hosp)   list = list.filter(r => r.hospital === hosp);
    if (period) list = list.filter(r => r.period === period);
    if (search) list = list.filter(r =>
      (r.enteredBy || '').toLowerCase().includes(search) ||
      (r.department || '').toLowerCase().includes(search) ||
      this.roundNo(r).toLowerCase().includes(search));
    return list;
  },

  render() {
    // العدادات (على كل الجولات — بلا فلاتر)
    const counts = { pending: 0, approved: 0, rejected: 0 };
    this.rounds.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
    document.getElementById('apvCount-pending').textContent  = counts.pending;
    document.getElementById('apvCount-approved').textContent = counts.approved;
    document.getElementById('apvCount-rejected').textContent = counts.rejected;
    document.getElementById('apvCount-all').textContent      = this.rounds.length;

    const list = this._filtered();
    const countEl = document.getElementById('apvTableCount');
    if (countEl) countEl.textContent = `(${list.length} جولة)`;

    const tbody = document.getElementById('apvBody');
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><i class="fas fa-inbox"></i><p>لا توجد جولات مطابقة</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(r => `
      <tr onclick="ApprovalsApp.openDetail('${esc(r.id)}')" title="اضغط لعرض التفاصيل الكاملة">
        <td><strong style="direction:ltr;display:inline-block">${this.roundNo(r)}</strong></td>
        <td>${esc(r.date)}</td>
        <td>${esc(r.day) || DB.getDayName(r.date)}</td>
        <td><span class="badge badge-info">${esc(r.period) || '-'}</span></td>
        <td style="font-size:12.5px">${esc(r.hospital) || '-'}</td>
        <td>${esc(r.department) || '-'}</td>
        <td>${esc(r.enteredBy) || '-'}</td>
        <td style="font-size:12.5px;white-space:nowrap">${this._fmtDateTime(r.createdAt)}</td>
        <td>${this._badge(r)}${r.returnedForEdit && r.status !== 'rejected' ? '<span class="apv-returned-flag"><i class="fas fa-rotate-right"></i> مُعادة للموظف للتعديل</span>' : ''}</td>
      </tr>`).join('');
  },

  /* ================= صفحة التفاصيل ================= */
  openDetail(id) {
    const r = this.rounds.find(x => x.id === id);
    if (!r) return;
    const row = (label, val) => `
      <div style="background:var(--surface-2);border-radius:8px;padding:12px 14px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${label}</div>
        <div style="font-size:14px;font-weight:600">${val}</div>
      </div>`;

    document.getElementById('apvDetailNo').textContent = this.roundNo(r);
    const body = document.getElementById('apvDetailBody');
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        ${row('التاريخ', esc(r.date))}
        ${row('اليوم', esc(r.day) || DB.getDayName(r.date))}
        ${row('الفترة', `<span class="badge badge-info">${esc(r.period)||'-'}</span>`)}
        ${row('المستشفى', esc(r.hospital)||'-')}
        ${row('القسم', esc(r.department)||'-')}
        ${row('حالة الجولة', this._badge(r))}
        ${row('إجمالي الموظفين', `<strong>${r.total||0}</strong>`)}
        ${row('الحضور', `<span style="color:var(--success);font-weight:700">${r.present||0}</span>`)}
        ${row('الغياب', `<span style="color:var(--danger);font-weight:700">${r.absent||0}</span>`)}
        ${row('المنسحبون', r.withdrawn||0)}
        ${row('المجازون', r.leave||0)}
        ${row('اسم مدخل البيانات', esc(r.enteredBy)||'-')}
        ${row('وقت الإدخال', this._fmtDateTime(r.createdAt))}
        ${row('رقم الجولة', `<span style="direction:ltr;display:inline-block">${this.roundNo(r)}</span>`)}
      </div>

      <div style="margin-top:16px"><strong>أسماء المتغيبين:</strong>
        <div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-top:8px;white-space:pre-wrap;font-size:14px">${esc(r.absentNames) || '<span style="color:var(--text-muted)">لا يوجد</span>'}</div>
      </div>
      <div style="margin-top:14px"><strong>الملاحظات:</strong>
        <div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-top:8px;white-space:pre-wrap;font-size:14px">${esc(r.notes) || '<span style="color:var(--text-muted)">لا توجد ملاحظات</span>'}</div>
      </div>
      <div style="margin-top:14px"><strong>الصور والمرفقات:</strong>
        <div style="background:var(--surface-2);border-radius:8px;padding:12px;margin-top:8px;font-size:13px;color:var(--text-muted)"><i class="fas fa-paperclip"></i> لا توجد مرفقات لهذه الجولة</div>
      </div>

      ${r.returnedForEdit && r.status !== 'rejected' ? `
        <div style="margin-top:16px;background:var(--warning-bg);border:1px solid var(--warning-border);border-radius:8px;padding:14px">
          <strong style="color:var(--warning)"><i class="fas fa-rotate-right"></i> مُعادة للموظف لإعادة التعديل</strong>
          ${r.returnNote ? `<p style="margin-top:6px;font-size:14px">${esc(r.returnNote)}</p>` : ''}
        </div>` : ''}

      ${r.status === 'rejected' && r.rejectionReason ? `
        <div style="margin-top:16px;background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:8px;padding:14px">
          <strong style="color:var(--danger)"><i class="fas fa-ban"></i> سبب الرفض:</strong>
          <p style="margin-top:6px;font-size:14px">${esc(r.rejectionReason)}</p>
          <p style="margin-top:6px;font-size:12px;color:var(--text-muted)">أُعيد السجل للموظف للتعديل — بعد التعديل تعود الحالة تلقائياً إلى "بانتظار الاعتماد"</p>
        </div>` : ''}

      ${r.status === 'approved' ? `
        <div class="signature-block" style="margin-top:20px;background:var(--success-bg);border:1px solid var(--success-border);border-radius:10px;padding:16px">
          <div style="font-weight:700;color:var(--success);margin-bottom:8px"><i class="fas fa-file-signature"></i> اعتماد ${esc(r.approverTitle) || 'مدير المناوبة'}</div>
          ${r.approvalSignature ? `<img src="${r.approvalSignature}" alt="التوقيع الإلكتروني" style="max-height:70px;display:block;margin-bottom:6px;background:#fff;border-radius:6px;padding:4px">` : ''}
          <div style="font-size:14px;font-weight:700">${esc(r.approvedBy) || '-'}</div>
          <div style="font-size:12.5px;color:var(--text-muted)">
            تاريخ الاعتماد: ${esc(r.approvedDate) || DB.formatDate(r.approvedAt)}
            &nbsp;|&nbsp; وقت الاعتماد: ${esc(r.approvedTime) || (r.approvedAt ? new Date(r.approvedAt).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }) : '-')}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px"><i class="fas fa-lock"></i> لا يُسمح بتعديل الجولة بعد الاعتماد إلا من المدير العام</div>
        </div>` : ''}

      <div style="margin-top:22px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        ${r.status !== 'approved' ? `
          <button class="btn btn-success" onclick="ApprovalsApp.openApprove('${esc(r.id)}')"><i class="fas fa-check"></i> اعتماد الجولة</button>
          <button class="btn btn-danger" onclick="ApprovalsApp.openReject('${esc(r.id)}')"><i class="fas fa-ban"></i> رفض الجولة</button>
          <button class="btn btn-outline" onclick="ApprovalsApp.openReturn('${esc(r.id)}')"><i class="fas fa-rotate-right"></i> رجوع للموظف لإعادة التعديل</button>
        ` : (this.mode === 'admin' ? `
          <button class="btn btn-danger" onclick="ApprovalsApp.unapprove('${esc(r.id)}')"><i class="fas fa-lock-open"></i> إلغاء الاعتماد (المدير العام)</button>
        ` : '')}
      </div>`;
    this.openModal('apvDetailModal');
  },

  /* ================= الاعتماد (توقيع إلزامي) ================= */
  openApprove(id) {
    document.getElementById('apvApproveId').value = id;
    this.closeModal('apvDetailModal');
    this.openModal('apvApproveModal');
    this._initSigPad();
    this.clearSignature();
  },

  _initSigPad() {
    const canvas = document.getElementById('apvSigCanvas');
    if (!canvas || canvas._sigInit) return;
    canvas._sigInit = true;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const pos = e => {
      const rect = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - rect.left) * (canvas.width / rect.width), y: (p.clientY - rect.top) * (canvas.height / rect.height) };
    };
    const start = e => {
      e.preventDefault();
      this._sigPad.drawing = true;
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#1a3a5c';
      const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
    };
    const move = e => {
      if (!this._sigPad.drawing) return;
      e.preventDefault();
      const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke();
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
    const canvas = document.getElementById('apvSigCanvas');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    this._sigPad.dirty = false;
  },

  async confirmApprove() {
    const id = document.getElementById('apvApproveId').value;
    if (!this._sigPad.dirty) return Toast.show('التوقيع الإلكتروني إلزامي — ارسم توقيعك داخل المربع', 'error');
    const signature = document.getElementById('apvSigCanvas').toDataURL('image/png');
    const btn = document.getElementById('apvApproveBtn');
    btn.disabled = true;
    try {
      if (this.mode === 'admin') {
        const now = new Date().toISOString();
        const { data, error } = await Cloud.sb.from('reports').update({
          status: 'approved', approved_by: 'المدير العام', approver_title: 'المدير العام',
          approved_at: now, approval_signature: signature,
          rejection_reason: null, rejected_at: null, returned_for_edit: false, return_note: null,
        }).eq('client_id', id).select('client_id');
        if (error) throw error;
        if (!data?.length) throw new Error('RLS منع التحديث — تأكد أن المستخدم مسجّل في admin_users');
      } else {
        const { data, error } = await Cloud.sb.rpc('manager_approve_report', { p_code: this.managerCode, p_client_id: id, p_signature: signature });
        if (error) throw error;
        if (data !== 'ok') {
          const msgs = { invalid_code: 'كودك لم يعد صالحاً — سجّل الدخول مجدداً', already_approved: 'الجولة معتمدة مسبقاً', not_found: 'الجولة غير موجودة', signature_required: 'التوقيع إلزامي' };
          throw new Error(msgs[data] || data);
        }
      }
      this.closeModal('apvApproveModal');
      Toast.show('تم اعتماد الجولة وتسجيل الاسم والتاريخ والوقت والتوقيع الإلكتروني', 'success');
      await this.reload(true);
    } catch (e) {
      console.error('[اعتماد الجولات] فشل الاعتماد:', e);
      Toast.show('فشل اعتماد الجولة: ' + (e.message || 'خطأ غير معروف'), 'error', 6000);
    } finally { btn.disabled = false; }
  },

  /* ================= الرفض (سبب إلزامي) ================= */
  openReject(id) {
    document.getElementById('apvRejectId').value = id;
    document.getElementById('apvRejectReason').value = '';
    this.closeModal('apvDetailModal');
    this.openModal('apvRejectModal');
  },

  async confirmReject() {
    const id = document.getElementById('apvRejectId').value;
    const reason = document.getElementById('apvRejectReason').value.trim();
    if (!reason) return Toast.show('سبب الرفض إلزامي', 'error');
    const btn = document.getElementById('apvRejectBtn');
    btn.disabled = true;
    try {
      if (this.mode === 'admin') {
        const { data, error } = await Cloud.sb.from('reports').update({
          status: 'rejected', rejection_reason: reason, rejected_at: new Date().toISOString(),
          returned_for_edit: true, approved_by: null, approved_at: null, approval_signature: null,
        }).eq('client_id', id).select('client_id');
        if (error) throw error;
        if (!data?.length) throw new Error('RLS منع التحديث');
      } else {
        const { data, error } = await Cloud.sb.rpc('manager_reject_report', { p_code: this.managerCode, p_client_id: id, p_reason: reason });
        if (error) throw error;
        if (data !== 'ok') {
          const msgs = { invalid_code: 'كودك لم يعد صالحاً', already_approved: 'لا يمكن رفض جولة معتمدة — يلزم إلغاء الاعتماد من المدير العام أولاً', not_found: 'الجولة غير موجودة', reason_required: 'سبب الرفض إلزامي' };
          throw new Error(msgs[data] || data);
        }
      }
      this.closeModal('apvRejectModal');
      Toast.show('تم رفض الجولة وإعادتها للموظف للتعديل', 'warning');
      await this.reload(true);
    } catch (e) {
      console.error('[اعتماد الجولات] فشل الرفض:', e);
      Toast.show('فشل رفض الجولة: ' + (e.message || 'خطأ غير معروف'), 'error', 6000);
    } finally { btn.disabled = false; }
  },

  /* ================= الإرجاع للموظف ================= */
  openReturn(id) {
    document.getElementById('apvReturnId').value = id;
    document.getElementById('apvReturnNote').value = '';
    this.closeModal('apvDetailModal');
    this.openModal('apvReturnModal');
  },

  async confirmReturn() {
    const id = document.getElementById('apvReturnId').value;
    const note = document.getElementById('apvReturnNote').value.trim();
    const btn = document.getElementById('apvReturnBtn');
    btn.disabled = true;
    try {
      if (this.mode === 'admin') {
        const { data, error } = await Cloud.sb.from('reports').update({
          returned_for_edit: true, return_note: note || null,
        }).eq('client_id', id).select('client_id');
        if (error) throw error;
        if (!data?.length) throw new Error('RLS منع التحديث');
      } else {
        const { data, error } = await Cloud.sb.rpc('manager_return_report', { p_code: this.managerCode, p_client_id: id, p_note: note });
        if (error) throw error;
        if (data !== 'ok') {
          const msgs = { invalid_code: 'كودك لم يعد صالحاً', already_approved: 'الجولة معتمدة — لا يمكن إرجاعها', not_found: 'الجولة غير موجودة' };
          throw new Error(msgs[data] || data);
        }
      }
      this.closeModal('apvReturnModal');
      Toast.show('أُعيدت الجولة للموظف لإعادة التعديل', 'success');
      await this.reload(true);
    } catch (e) {
      console.error('[اعتماد الجولات] فشل الإرجاع:', e);
      Toast.show('فشل إرجاع الجولة: ' + (e.message || 'خطأ غير معروف'), 'error', 6000);
    } finally { btn.disabled = false; }
  },

  /* ================= إلغاء الاعتماد (المدير العام فقط) ================= */
  async unapprove(id) {
    if (this.mode !== 'admin') return;
    try {
      const { data, error } = await Cloud.sb.from('reports').update({
        status: 'pending', approved_by: null, approver_title: null,
        approved_at: null, approval_signature: null,
      }).eq('client_id', id).select('client_id');
      if (error) throw error;
      if (!data?.length) throw new Error('RLS منع التحديث');
      this.closeModal('apvDetailModal');
      Toast.show('تم إلغاء الاعتماد — عادت الجولة إلى "بانتظار الاعتماد"', 'warning');
      await this.reload(true);
    } catch (e) {
      console.error('[اعتماد الجولات] فشل إلغاء الاعتماد:', e);
      Toast.show('فشل إلغاء الاعتماد: ' + (e.message || 'خطأ غير معروف'), 'error', 6000);
    }
  },

  /* ================= مودال ================= */
  openModal(id)  { const m = document.getElementById(id); if (m) { m.classList.add('open'); document.body.style.overflow = 'hidden'; } },
  closeModal(id) { const m = document.getElementById(id); if (m) { m.classList.remove('open'); document.body.style.overflow = ''; } },
};

document.addEventListener('DOMContentLoaded', () => {
  if (document.body.dataset.page === 'approvals') ApprovalsApp.init();
});
