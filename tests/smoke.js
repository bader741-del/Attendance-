/* اختبار دخاني: تحميل الصفحة في jsdom مع بيانات محلية مزروعة والتأكد من البطاقات والفلاتر والمودال */
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const dir = require('path').resolve(__dirname, '..');
let html = fs.readFileSync(path.join(dir, 'hospital-map.html'), 'utf8');
// أزل السكربتات الخارجية (CDN) — نختبر منطقنا فقط، Leaflet/Chart اختياريان بحمايات
html = html.replace(/<script src="https:[^"]+"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/hospital-map.html', pretendToBeVisual: true });
const { window } = dom;
window.matchMedia = window.matchMedia || (() => ({ matches:false, addListener(){}, removeListener(){} }));

const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const T = iso(today);

// زرع بيانات محلية (وضع بلا سحابة — config placeholders)
window.localStorage.setItem('mksh_reports', JSON.stringify([
  { id:'r1', date:T, hospital:'مستشفى المدينة الرئيسي', department:'الطوارئ', period:'صباحي', present:96, absent:2, withdrawn:1, leave:1, status:'approved', createdAt:new Date().toISOString(), enteredBy:'أحمد' },
  { id:'r2', date:T, hospital:'مستشفى النساء والأطفال', department:'الولادة', period:'صباحي', present:44, absent:5, withdrawn:1, leave:0, status:'pending', createdAt:new Date().toISOString(), enteredBy:'سارة' },
  { id:'r3', date:T, hospital:'مستشفى الطب النفسي', department:'العيادات', period:'صباحي', present:20, absent:8, withdrawn:2, leave:0, status:'approved', createdAt:new Date().toISOString(), enteredBy:'خالد' },
  { id:'r4', date:T, hospital:'مستشفى المدينة الرئيسي', department:'الباطنة', period:'مسائي', present:50, absent:0, withdrawn:0, leave:0, status:'rejected', createdAt:new Date().toISOString() },
]));
window.localStorage.setItem('mksh_employees', JSON.stringify([
  { id:'e1', name:'x', code:'A1', hospital:'مستشفى المدينة الرئيسي' },
  { id:'e2', name:'y', code:'A2', hospital:'مستشفى النساء والأطفال' },
]));
window.sessionStorage.setItem('mksh_admin_session', '1'); // مسؤول مسجَّل

const code = ['config.js','script.js','analytics-core.js','hospital-map.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');
window.eval(code + '\n;window.HospitalMap = HospitalMap;');
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles:true }));

setTimeout(() => {
  const doc = window.document;
  const fail = m => { console.error('FAIL:', m); process.exit(1); };

  if (doc.getElementById('mapContent').style.display !== 'flex') fail('content not shown for logged-in admin');
  const cards = doc.querySelectorAll('.hosp-card');
  if (cards.length !== 3) fail('expected 3 hospital cards, got ' + cards.length);

  const txt = doc.getElementById('hospCardsGrid').textContent;
  // الرئيسي: 96/(96+2+1+1)=96% ← أصفر (المرفوض r4 مستبعد)
  if (!txt.includes('96%')) fail('main hospital rate 96% missing (rejected report must be excluded)');
  // النفسي: 20/30=67% ← أحمر
  if (!txt.includes('67%')) fail('mental health 67% missing');
  const main = [...cards].find(c => c.textContent.includes('مستشفى المدينة الرئيسي'));
  if (!main.className.includes('status-green')) fail('main hospital should be green (96%): ' + main.className);
  const mh = [...cards].find(c => c.textContent.includes('مستشفى الطب النفسي'));
  if (!mh.className.includes('status-red')) fail('mental health should be red (67%)');
  const wc = [...cards].find(c => c.textContent.includes('مستشفى النساء والأطفال'));
  if (!wc.className.includes('status-yellow')) fail('maternity should be yellow (88%)');
  if (!wc.textContent.includes('بانتظار الاعتماد')) fail('pending label missing');

  // المودال التفصيلي
  window.HospitalMap.openDetail('مستشفى المدينة الرئيسي');
  if (!doc.getElementById('hospDetailModal').classList.contains('open')) fail('modal did not open');
  if (!doc.getElementById('hospDeptBody').textContent.includes('الطوارئ')) fail('dept table missing الطوارئ');
  // ترتيب الأقسام داخل اللوحة التفصيلية
  if (!doc.getElementById('hospBestDepts').textContent.includes('الطوارئ')) fail('best depts missing');
  window.HospitalMap.openDetail('مستشفى الطب النفسي');
  if (!doc.getElementById('hospAbsentDepts').textContent.includes('العيادات')) fail('absent depts missing');
  window.HospitalMap.openDetail('مستشفى المدينة الرئيسي');
  window.HospitalMap.showTab('weekly');
  if (!doc.getElementById('hospTabBody').textContent.includes(T)) fail('weekly tab missing today row');
  window.HospitalMap.showTab('daily');
  if (!doc.getElementById('hospTabBody').textContent.includes('أحمد')) fail('daily tab missing entered-by');

  // الفلاتر
  window.HospitalMap.applyPreset('yesterday');
  const grid = doc.getElementById('hospCardsGrid').textContent;
  if (grid.includes('96%')) fail('yesterday filter still shows today data');
  window.HospitalMap.applyPreset('month');
  if (!doc.getElementById('hospCardsGrid').textContent.includes('96%')) fail('month filter should include today');

  console.log('SMOKE OK: cards, colors, thresholds, rejected-exclusion, modal, tabs, filters');
  process.exit(0);
}, 300);
