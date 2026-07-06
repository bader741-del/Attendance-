/* اختبار دخاني لمركز القيادة: بيانات مزروعة تشمل فترتين + جداول دوام (للالتزام) */
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const dir = require('path').resolve(__dirname, '..');
let html = fs.readFileSync(path.join(dir, 'executive.html'), 'utf8');
html = html.replace(/<script src="https:[^"]+"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/executive.html', pretendToBeVisual: true });
const { window } = dom;

const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const now = new Date(); const T = iso(now);
const y = new Date(now); y.setDate(now.getDate()-1); const Y = iso(y);

const H1='مستشفى المدينة الرئيسي', H2='مستشفى النساء والأطفال', H3='مستشفى الطب النفسي';
window.localStorage.setItem('mksh_reports', JSON.stringify([
  // اليوم: الرئيسي ممتاز، النفسي حرج، النساء لا تقرير اليوم (تنبيه)
  { id:'r1', date:T, hospital:H1, department:'الطوارئ', period:'صباحي', present:97, absent:1, withdrawn:1, leave:1, status:'approved', createdAt:new Date().toISOString(), enteredBy:'أحمد' },
  { id:'r3', date:T, hospital:H3, department:'العيادات', period:'صباحي', present:15, absent:12, withdrawn:2, leave:1, status:'pending', createdAt:new Date().toISOString(), enteredBy:'خالد' },
  // أمس (الفترة السابقة لفلتر اليوم)
  { id:'r5', date:Y, hospital:H1, department:'الطوارئ', period:'صباحي', present:80, absent:20, withdrawn:0, leave:0, status:'approved', createdAt:new Date().toISOString() },
]));
window.localStorage.setItem('mksh_employees', JSON.stringify([
  { id:'e1', name:'x', code:'A1', hospital:H1 }, { id:'e2', name:'y', code:'A2', hospital:H2 }, { id:'e3', name:'z', code:'A3', hospital:H3 },
]));
window.localStorage.setItem('mksh_shifts', JSON.stringify([
  { id:'s1', hospital:H1, department:'الطوارئ', period:'صباحي', requiredCount:100 },
  { id:'s2', hospital:H2, department:'الولادة', period:'صباحي', requiredCount:50 },
]));
window.sessionStorage.setItem('mksh_admin_session', '1');

const code = ['config.js','script.js','analytics-core.js','executive.js'].map(f => fs.readFileSync(path.join(dir,f),'utf8')).join('\n;\n');
window.eval(code + '\n;window.ExecutiveApp = ExecutiveApp; window.Analytics = Analytics;');
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles:true }));

setTimeout(() => {
  const doc = window.document;
  const fail = m => { console.error('FAIL:', m); process.exit(1); };
  const txt = id => doc.getElementById(id).textContent;

  if (doc.getElementById('execContent').style.display !== 'flex') fail('content not shown');

  // KPIs: 9 بطاقات — حاضر 112، غائب 13
  const kpis = doc.querySelectorAll('.exec-kpi');
  if (kpis.length !== 9) fail('expected 9 KPIs, got '+kpis.length);
  if (!txt('execKpiGrid').includes('112')) fail('present sum 112 missing');
  if (!txt('execKpiGrid').includes('إجمالي الموظفين')) fail('total employees KPI missing');

  // الالتزام اليوم: خانتا جدول متوقعتان، واحدة مغطاة = 50%
  if (!txt('execKpiGrid').includes('50%')) fail('compliance 50% missing');

  // التنبيهات: النفسي حرج (<85) + النساء بلا تقرير اليوم
  const alerts = txt('execAlerts');
  if (!alerts.includes(H3)) fail('critical hospital alert missing');
  if (!alerts.includes(H2) || !alerts.includes('لم يُرفع')) fail('missing-report alert missing');

  // المقارنة: 3 صفوف + تقارير ناقصة رقمية
  if (doc.querySelectorAll('#execCompareBody tr').length !== 3) fail('compare rows != 3');

  // الأفضل أداءً: أفضل مستشفى = الرئيسي (97%)
  const top = txt('execTopGrid');
  if (!top.includes(H1)) fail('top hospital should be main');
  if (!top.includes('97%')) fail('top rate 97% missing');

  // الرؤى: تغير الحضور مقابل أمس (80% ← 86%؟) إجمالي اليوم = 112/130=86% أمس=80% → ارتفاع
  const ins = txt('execInsights');
  if (!ins.includes('نسبة الحضور')) fail('attendance insight missing');
  if (!ins.includes('الأعلى التزاماً')) fail('compliance insight missing');

  // الخريطة الحرارية: 3 صفوف × خلية يوم واحد
  if (doc.querySelectorAll('#execHeatmap .hm-cell').length !== 3) fail('heatmap cells != 3');
  if (!doc.querySelector('#execHeatmap .hm-green')) fail('heatmap green cell missing');
  if (!doc.querySelector('#execHeatmap .hm-red')) fail('heatmap red cell missing');

  // الملخص التنفيذي (لقطة اليوم): 6 عناصر + مستشفيات تحتاج انتباهاً = 2 (النساء بلا بيانات + النفسي حرج)
  if (doc.querySelectorAll('#execSummary .exec-summary-item').length !== 6) fail('summary items != 6');
  const sm = txt('execSummary');
  if (!sm.includes('حضور اليوم')) fail('summary attendance missing');
  if (!sm.includes('مستشفيات تحتاج انتباهاً')) fail('summary attention missing');

  // أقسام تتطلب متابعة: العيادات (النفسي، حضور 50%)
  const att = txt('execAttentionDepts');
  if (!att.includes('العيادات')) fail('attention dept العيادات missing');
  if (att.includes('الطوارئ')) fail('الطوارئ (97%) must NOT need attention');

  // الفلاتر: أمس → حاضر 80
  window.ExecutiveApp.applyPreset('yesterday');
  if (!txt('execKpiGrid').includes('80')) fail('yesterday filter: present 80 missing');
  window.ExecutiveApp.applyPreset('year');
  if (!txt('execKpiGrid').includes('192')) fail('year filter: present 192 missing');

  // فحص prevRange/rangeFor
  const pr = window.Analytics.prevRange('2026-07-01','2026-07-07');
  if (pr.from !== '2026-06-24' || pr.to !== '2026-06-30') fail('prevRange wrong: '+JSON.stringify(pr));

  console.log('EXEC SMOKE OK: KPIs, compliance, alerts, compare, top, insights, heatmap, filters, prevRange');
  process.exit(0);
}, 300);
