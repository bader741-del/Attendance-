/* اختبار دخاني: نظام اعتماد الجولات
   - approvals.html: شاشة الدخول تظهر بلا سحابة، والمودالات والجدول موجودة
   - admin.html: رابط اعتماد الجولات + بطاقات الجولات + فلاتر حالة التقارير + قسم مدراء المناوبة
   - employee.html: لوحة الجولات المُعادة/المرفوضة + وضع التعديل (محلياً بلا سحابة) */
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const dir = path.resolve(__dirname, '..');
const fail = m => { console.error('FAIL:', m); process.exit(1); };
const load = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/<script src="https:[^"]+"[^>]*><\/script>/g, '');

/* ===== (1) approvals.html ===== */
{
  const dom = new JSDOM(load('approvals.html'), { runScripts: 'outside-only', url: 'https://example.test/approvals.html', pretendToBeVisual: true });
  const { window } = dom;
  const code = ['config.js', 'script.js', 'approvals.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');
  window.eval(code + '\n;window.ApprovalsApp = ApprovalsApp;');
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const doc = window.document;
  // بلا مكتبة supabase (CDN محذوف) → Cloud.on() = false → تظهر شاشة الدخول
  if (doc.getElementById('apvLogin').style.display !== 'flex') fail('approvals: login screen not shown without cloud');
  ['apvDetailModal','apvApproveModal','apvRejectModal','apvReturnModal','apvSigCanvas','apvBody',
   'apvCount-pending','apvCount-approved','apvCount-rejected'].forEach(id => {
    if (!doc.getElementById(id)) fail('approvals: missing #' + id);
  });
  // فحص العرض والفلاتر ببيانات مزروعة
  const A = window.ApprovalsApp;
  A.rounds = [
    { id: 'x1', date: '2026-07-01', period: 'صباحي', hospital: 'مستشفى المدينة الرئيسي', department: 'الطوارئ', enteredBy: 'أحمد', status: 'pending',  createdAt: new Date().toISOString() },
    { id: 'x2', date: '2026-07-01', period: 'مسائي', hospital: 'مستشفى الطب النفسي',    department: 'العيادات', enteredBy: 'سارة', status: 'approved', createdAt: new Date().toISOString(), approvedBy: 'مدير', approvalSignature: '' },
    { id: 'x3', date: '2026-07-02', period: 'ليلي',  hospital: 'مستشفى النساء والأطفال', department: 'الولادة', enteredBy: 'خالد', status: 'rejected', createdAt: new Date().toISOString(), rejectionReason: 'نقص بيانات' },
  ];
  A.statusFilter = '';
  A.render();
  if (doc.getElementById('apvCount-pending').textContent !== '1')  fail('approvals: pending counter');
  if (doc.getElementById('apvCount-approved').textContent !== '1') fail('approvals: approved counter');
  if (doc.getElementById('apvCount-rejected').textContent !== '1') fail('approvals: rejected counter');
  if (doc.querySelectorAll('#apvBody tr').length !== 3) fail('approvals: table rows');
  A.setStatusFilter('pending');
  if (doc.querySelectorAll('#apvBody tr').length !== 1) fail('approvals: pending filter');
  A.openDetail('x1');
  const detail = doc.getElementById('apvDetailBody').innerHTML;
  if (!detail.includes('اعتماد الجولة') || !detail.includes('رفض الجولة') || !detail.includes('رجوع للموظف')) fail('approvals: action buttons missing in detail');
  A.openDetail('x2');
  if (doc.getElementById('apvDetailBody').innerHTML.includes('رفض الجولة')) fail('approvals: approved round must not show reject button');
  console.log('OK: approvals.html');
}

/* ===== (2) admin.html ===== */
{
  const dom = new JSDOM(load('admin.html'), { runScripts: 'outside-only', url: 'https://example.test/admin.html', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  const T = '2026-07-09';
  window.localStorage.setItem('mksh_reports', JSON.stringify([
    { id: 'r1', date: T, hospital: 'مستشفى المدينة الرئيسي', department: 'الطوارئ', period: 'صباحي', present: 9, absent: 1, status: 'approved', createdAt: new Date().toISOString() },
    { id: 'r2', date: T, hospital: 'مستشفى المدينة الرئيسي', department: 'الباطنة', period: 'صباحي', present: 5, absent: 0, status: 'pending',  createdAt: new Date().toISOString() },
    { id: 'r3', date: T, hospital: 'مستشفى الطب النفسي',    department: 'العيادات', period: 'مسائي', present: 4, absent: 2, status: 'rejected', createdAt: new Date().toISOString() },
    { id: 'r4', date: T, hospital: 'مستشفى الطب النفسي',    department: 'التنويم',  period: 'ليلي',  present: 6, absent: 0, status: 'approved', createdAt: new Date().toISOString() },
  ]));
  window.sessionStorage.setItem('mksh_admin_session', '1');
  const code = ['config.js', 'script.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');
  window.eval(code + '\n;window.AdminApp = AdminApp; window.DB = DB;');
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const doc = window.document;

  if (!doc.querySelector('.nav-item[onclick*="approvals.html"]')) fail('admin: approvals nav link missing');
  if (!doc.querySelector('.nav-item[data-section="managers"]'))   fail('admin: managers nav item missing');

  // بطاقات الجولات (الفلتر الافتراضي: اليوم — التواريخ المزروعة قد لا تطابق، نضبط النطاق)
  doc.getElementById('dashDateFrom').value = T;
  doc.getElementById('dashDateTo').value = T;
  window.AdminApp.loadDashboard();
  if (doc.getElementById('stat-roundsApproved').textContent !== '2') fail('admin: approved rounds card');
  if (doc.getElementById('stat-roundsPending').textContent  !== '1') fail('admin: pending rounds card');
  if (doc.getElementById('stat-roundsRejected').textContent !== '1') fail('admin: rejected rounds card');
  if (doc.getElementById('stat-approvalRate').textContent   !== '50%') fail('admin: approval rate card, got ' + doc.getElementById('stat-approvalRate').textContent);

  // التقرير اليومي: الافتراضي المعتمدة فقط
  doc.getElementById('dailyDate').value = T;
  window.AdminApp.renderDailyReport();
  let rows = doc.querySelectorAll('#dailyReportBody tbody tr').length;
  if (rows !== 2) fail('admin: daily report should show 2 approved by default, got ' + rows);
  doc.getElementById('dailyStatus').value = '';
  window.AdminApp.renderDailyReport();
  rows = doc.querySelectorAll('#dailyReportBody tbody tr').length;
  if (rows !== 4) fail('admin: daily report all statuses should show 4, got ' + rows);

  // قسم مدراء المناوبة يعمل بلا سحابة (رسالة إرشادية)
  window.AdminApp.showSection('managers');
  if (!doc.getElementById('managersBody').innerHTML.includes('Supabase')) fail('admin: managers section fallback message');
  console.log('OK: admin.html');
}

/* ===== (3) employee.html — جولة متعددة الأقسام + بوابة اعتماد المدير المناوب + تعديل تقرير مرفوض ===== */
{
  const dom = new JSDOM(load('employee.html'), { runScripts: 'outside-only', url: 'https://example.test/employee.html', pretendToBeVisual: true });
  const { window } = dom;
  const T = '2026-07-08';
  window.localStorage.setItem('mksh_reports', JSON.stringify([
    { id: 'rr1', date: T, hospital: 'مستشفى المدينة الرئيسي', department: 'الطوارئ', period: 'صباحي',
      total: 10, present: 8, absent: 2, withdrawn: 0, leave: 0, status: 'rejected', rejectionReason: 'أرقام غير مكتملة',
      employeeCode: 'A1', enteredBy: 'أحمد', createdAt: new Date().toISOString() },
  ]));
  window.localStorage.setItem('mksh_employees', JSON.stringify([{ id: 'e1', name: 'أحمد', code: 'A1' }]));
  window.localStorage.setItem('mksh_departments', JSON.stringify([
    { id: 'd1', name: 'الطوارئ', hospital: 'مستشفى المدينة الرئيسي' },
    { id: 'd2', name: 'التمريض', hospital: 'مستشفى المدينة الرئيسي' },
    { id: 'd3', name: 'الأشعة',  hospital: 'مستشفى المدينة الرئيسي' },
  ]));
  window.sessionStorage.setItem('mksh_emp_session', JSON.stringify({ name: 'أحمد', code: 'A1' }));
  const code = ['config.js', 'script.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');
  window.eval(code + '\n;window.EmployeeApp = EmployeeApp; window.DB = DB;');
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  setTimeout(async () => {
    const doc = window.document;
    const E = window.EmployeeApp;

    /* --- (أ) نموذج الجولة متعددة الأقسام --- */
    if (doc.querySelectorAll('#roundSections .emp-section-card').length !== 1) fail('employee: initial section card missing');
    ['mgrApprovalCode','mgrApprovalName','roundSigCanvas','approveRoundBtn','addSectionBtn','roundApprovedBanner','approvalHint',
     'saveRoundBtn','approvedTopMsg','approvalDoneMark','cancelApprovalBtn'].forEach(id => {
      if (!doc.getElementById(id)) fail('employee: missing approval element #' + id);
    });
    // قسم الاعتماد مخفي قبل اكتمال إدخال الأقسام + زر الحفظ معطل طوال فترة الإدخال
    if (doc.getElementById('roundApprovalBlock').style.display !== 'none') fail('employee: approval block must be hidden before sections complete');
    if (doc.getElementById('approvalHint').style.display === 'none') fail('employee: hint must show before sections complete');
    if (!doc.getElementById('saveRoundBtn').disabled) fail('employee: save button must be disabled during entry');

    E.addSection();
    E.addSection();
    if (doc.querySelectorAll('#roundSections .emp-section-card').length !== 3) fail('employee: addSection failed');
    E.removeSection(doc.querySelectorAll('#roundSections .secRemoveBtn')[2]);
    if (doc.querySelectorAll('#roundSections .emp-section-card').length !== 2) fail('employee: removeSection failed');

    // تعبئة الرأس وقسمين
    doc.getElementById('repDate').value = '2026-07-09';
    doc.getElementById('repPeriod').value = 'صباحي';
    doc.getElementById('repHospital').value = 'مستشفى المدينة الرئيسي';
    E.loadDepts();
    const cards = doc.querySelectorAll('#roundSections .emp-section-card');
    cards[0].querySelector('.secDept').value = 'الطوارئ';
    cards[0].querySelector('.secTotal').value = '10';
    cards[0].querySelector('.secPresent').value = '10';
    cards[1].querySelector('.secDept').value = 'التمريض';
    cards[1].querySelector('.secTotal').value = '5';
    cards[1].querySelector('.secPresent').value = '5';

    const col = E._collectSections();
    if (!col.ok || col.sections.length !== 2) fail('employee: _collectSections failed: ' + (col.msg || ''));
    if (col.sections[0].department !== 'الطوارئ' || col.sections[1].department !== 'التمريض') fail('employee: sections data wrong');

    // بعد اكتمال الإدخال يظهر قسم "اعتماد الجولة" تلقائياً
    E.checkRoundComplete();
    if (doc.getElementById('roundApprovalBlock').style.display === 'none') fail('employee: approval block must appear after sections complete');
    if (doc.getElementById('approvalHint').style.display !== 'none') fail('employee: hint must hide after sections complete');

    /* --- (ب) بوابة الاعتماد: لا اعتماد ولا حفظ بدون كود وتوقيع المدير المناوب --- */
    await E.approveRound();
    if (doc.getElementById('approvalGateMsg').style.display !== 'block') fail('employee: approval gate message not shown');
    if (E._roundApproval) fail('employee: approval must not be set without code/signature');
    await E.saveRound();
    if (doc.getElementById('roundApprovedBanner').style.display === 'block') fail('employee: round must NOT be saved without manager approval');
    if (doc.getElementById('empSuccessMsg').style.display === 'block') fail('employee: round must NOT be saved without manager approval (success msg)');

    /* --- (ب2) بعد اعتماد المدير المناوب: قسم أخضر + ✓ + رسالة أعلى الصفحة + تفعيل زر الحفظ --- */
    E._roundApproval = { mgrCode: 'MGRTEST', mgrName: 'مدير الاختبار', signature: 'data:image/png;base64,x', count: 2 };
    E._applyApprovedState(true);
    if (doc.getElementById('saveRoundBtn').disabled) fail('employee: save button must enable after approval');
    if (doc.getElementById('approvedTopMsg').style.display !== 'block') fail('employee: top approved message not shown');
    if (doc.getElementById('approvalDoneMark').style.display !== 'block') fail('employee: ✓ mark not shown');
    if (!doc.getElementById('approvalDoneBy').textContent.includes('مدير الاختبار')) fail('employee: manager name missing in ✓ mark');
    if (!doc.getElementById('roundApprovalBlock').style.background.includes('success')) fail('employee: approval block must turn green');
    if (!doc.getElementById('repDate').disabled) fail('employee: sections must lock after approval');
    if (doc.getElementById('cancelApprovalBtn').disabled) fail('employee: cancel-approval button must stay enabled');

    /* --- (ب3) إلغاء الاعتماد قبل الحفظ النهائي يعيد التعديل ويعطل الحفظ --- */
    E.cancelApproval();
    if (E._roundApproval) fail('employee: approval must clear on cancel');
    if (!doc.getElementById('saveRoundBtn').disabled) fail('employee: save button must disable after cancel');
    if (doc.getElementById('repDate').disabled) fail('employee: fields must unlock after cancel');
    if (doc.getElementById('approvedTopMsg').style.display === 'block') fail('employee: top message must hide after cancel');

    /* --- (ب4) القفل النهائي بعد الحفظ ثم فك القفل بجولة جديدة --- */
    E._lockRound('مدير الاختبار', 2);
    if (doc.getElementById('roundApprovedBanner').style.display !== 'block') fail('employee: approved banner not shown after lock');
    if (!doc.getElementById('roundApprovedInfo').textContent.includes('مدير الاختبار')) fail('employee: manager name missing in banner');
    if (!doc.getElementById('repDate').disabled) fail('employee: fields must lock after approval');
    if (doc.getElementById('roundApprovalBlock').style.display !== 'none') fail('employee: approval block must hide after lock');
    E.newReport();
    if (doc.getElementById('roundApprovedBanner').style.display === 'block') fail('employee: banner must hide on new round');
    if (doc.getElementById('repDate').disabled) fail('employee: fields must unlock on new round');
    if (doc.getElementById('roundApprovalBlock').style.display !== 'none') fail('employee: approval block must hide for fresh empty round');

    /* --- (ج) تعديل تقرير قديم مرفوض — يعود إلى بانتظار الاعتماد --- */
    if (doc.getElementById('empMyRounds').style.display !== 'block') fail('employee: rejected rounds panel not shown');
    if (!doc.getElementById('empMyRoundsList').innerHTML.includes('أرقام غير مكتملة')) fail('employee: rejection reason not shown');

    E.editRound('rr1');
    if (E.editingId !== 'rr1') fail('employee: editing mode not set');
    const eCard = doc.querySelector('#roundSections .emp-section-card');
    if (eCard.querySelector('.secTotal').value !== '10') fail('employee: edit form not prefilled');
    if (eCard.querySelector('.secDept').value !== 'الطوارئ') fail('employee: edit dept not prefilled');
    if (doc.getElementById('roundApprovalBlock').style.display !== 'none') fail('employee: approval block must hide in edit mode');
    if (doc.getElementById('saveEditBtn').style.display === 'none') fail('employee: save-edit button must show in edit mode');

    eCard.querySelector('.secPresent').value = '9';
    eCard.querySelector('.secAbsent').value = '1';
    await E.saveEditedReport();

    const saved = JSON.parse(window.localStorage.getItem('mksh_reports')).find(r => r.id === 'rr1');
    if (saved.status !== 'pending') fail('employee: status must return to pending after edit, got ' + saved.status);
    if (+saved.present !== 9) fail('employee: edited values not saved');
    if (E.editingId !== null) fail('employee: editing mode not cleared');
    console.log('OK: employee.html multi-section round + approval gate + edit flow');
    console.log('APPROVALS SMOKE OK: approvals page, admin cards/filters/nav, employee round entry & approval gate & edit-resubmit');
  }, 50);
}
