/* اختبار دخاني لنظام التقارير التنفيذية (المرحلة 15) — jsdom */
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const dir = require('path').resolve(__dirname, '..');
let html = fs.readFileSync(path.join(dir, 'exec-reports.html'), 'utf8');
html = html.replace(/<script src="https:[^"]+"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/exec-reports.html', pretendToBeVisual: true });
const { window } = dom;

const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const now = new Date(); const T = iso(now);
const y = new Date(now); y.setDate(now.getDate()-1); const Y = iso(y);

const H1='مستشفى المدينة الرئيسي', H3='مستشفى الطب النفسي';
window.localStorage.setItem('mksh_reports', JSON.stringify([
  { id:'r1', date:T, hospital:H1, department:'الطوارئ', period:'صباحي', present:96, absent:2, withdrawn:1, leave:1, status:'approved', createdAt:new Date().toISOString(), employeeCode:'A1', enteredBy:'أحمد' },
  { id:'r2', date:T, hospital:H3, department:'العيادات', period:'صباحي', present:20, absent:9, withdrawn:1, leave:0, status:'pending', createdAt:new Date().toISOString(), employeeCode:'A3', enteredBy:'خالد' },
  { id:'r3', date:Y, hospital:H1, department:'الطوارئ', period:'صباحي', present:85, absent:15, withdrawn:0, leave:0, status:'approved', createdAt:new Date().toISOString(), employeeCode:'A1' },
]));
window.localStorage.setItem('mksh_employees', JSON.stringify([
  { id:'e1', name:'أحمد', code:'A1', hospital:H1 }, { id:'e3', name:'خالد', code:'A3', hospital:H3 },
]));
window.localStorage.setItem('mksh_departments', JSON.stringify([
  { id:'d1', name:'الطوارئ', hospital:H1 }, { id:'d2', name:'العيادات', hospital:H3 },
]));
window.localStorage.setItem('mksh_shifts', JSON.stringify([
  { id:'s1', hospital:H1, department:'الطوارئ', period:'صباحي', requiredCount:100 },
]));
window.sessionStorage.setItem('mksh_admin_session', '1');

const code = ['config.js','script.js','analytics-core.js','exec-reports.js']
  .map(f => fs.readFileSync(path.join(dir,f),'utf8')).join('\n;\n');
window.eval(code + '\n;window.ExecReports = ExecReports;');
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles:true }));

setTimeout(async () => {
  const doc = window.document;
  const fail = m => { console.error('FAIL:', m); process.exit(1); };

  if (doc.getElementById('rptContent').style.display !== 'flex') fail('content not shown');

  // الفلاتر معبّأة
  if (doc.querySelectorAll('#rptHospital option').length !== 4) fail('hospital filter options != 4');
  if (![...doc.querySelectorAll('#rptEmployee option')].some(o => o.textContent.includes('أحمد'))) fail('employee filter missing');

  // توليد تقرير يومي (اليوم، كل المستشفيات)
  doc.getElementById('rptType').value = 'daily';
  doc.getElementById('rptDate').value = T;
  await window.ExecReports.generate();
  const docTxt = doc.getElementById('rptDoc').textContent;

  if (!doc.getElementById('rptPreviewWrap').classList.contains('show')) fail('preview not shown');
  if (!docTxt.includes('الملخص التنفيذي')) fail('executive summary missing');
  if (!docTxt.includes('تقرير يومي')) fail('report title missing');
  if (!docTxt.includes('منصة مراقبة الدوام')) fail('platform name missing');
  // حضور إجمالي اليوم: 116/130 = 89%
  if (!docTxt.includes('89%')) fail('overall attendance 89% missing');
  // الالتزام: خانة واحدة متوقعة ومغطاة = 100%
  if (!docTxt.includes('100%')) fail('compliance 100% missing');
  if (!docTxt.includes('الطوارئ')) fail('dept ranking missing الطوارئ');
  if (!docTxt.includes('ملاحظات مولّدة آلياً')) fail('observations section missing');
  if (!docTxt.includes('ملخص الأداء')) fail('performance summary missing');
  // ترويسة رسمية: تاريخ الإصدار موجود
  if (!docTxt.includes('تاريخ الإصدار')) fail('issue date missing');

  // فلترة بمستشفى واحد
  doc.getElementById('rptHospital').value = H3;
  await window.ExecReports.generate();
  const t2 = doc.getElementById('rptDoc').textContent;
  // النفسي فقط: 20/30 = 67%
  if (!t2.includes('67%')) fail('filtered report rate 67% missing');

  // فلترة بموظف
  doc.getElementById('rptHospital').value = '';
  doc.getElementById('rptEmployee').value = 'A1';
  await window.ExecReports.generate();
  if (doc.getElementById('rptDoc').textContent.includes('العيادات')) fail('employee filter leaked other records');

  // تقرير سنوي (يشمل اليوم وأمس)
  doc.getElementById('rptEmployee').value = '';
  doc.getElementById('rptType').value = 'annual';
  window.ExecReports._onTypeChange();
  await window.ExecReports.generate();
  if (!doc.getElementById('rptDoc').textContent.includes('تقرير سنوي')) fail('annual title missing');

  // التصدير لا ينهار دون XLSX (jsdom بلا CDN) — يعرض تنبيهاً فقط
  window.ExecReports.exportExcel();

  console.log('REPORTS SMOKE OK: filters, daily/annual generation, summary, compliance, observations, hospital/employee filters, export guard');
  process.exit(0);
}, 300);
