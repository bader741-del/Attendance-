/* انحدار: الصفحات الأصلية الثلاث تعمل كما قبل (تحميل + تهيئة دون أخطاء) */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs'), path = require('path');
const dir = require('path').resolve(__dirname, '..');

async function testPage(file, checks) {
  let html = fs.readFileSync(path.join(dir, file), 'utf8')
    .replace(/<script src="https:[^"]+"[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' + file, pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const scripts = ['config.js', 'script.js'];
  const code = scripts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');
  w.eval(code + '\n;window.__G = { DB, AdminApp, EmployeeApp, Theme };');
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  if (errors.length) throw new Error(file + ' JS errors: ' + errors.join(' | '));
  checks(w, w.document);
  console.log('OK:', file);
}

(async () => {
  try {
    await testPage('index.html', (w, d) => {
      if (!d.querySelector('.index-btn.admin')) throw new Error('index: admin button missing');
      if (!d.querySelector('.index-btn.employee')) throw new Error('index: employee button missing');
    });
    await testPage('admin.html', (w, d) => {
      if (d.getElementById('adminLogin').style.display !== 'flex') throw new Error('admin: login gate not shown');
      // كل أقسام اللوحة الأصلية ما تزال موجودة
      ['sec-dashboard','sec-analytics','sec-employees','sec-shifts','sec-departments','sec-reports','sec-daily','sec-weekly','sec-monthly','sec-audit','sec-settings']
        .forEach(id => { if (!d.getElementById(id)) throw new Error('admin: missing section ' + id); });
      // الروابط الجديدة موجودة دون المساس بالقائمة الأصلية
      if (d.querySelectorAll('.nav-item').length < 13) throw new Error('admin: nav items missing');
      if (!d.body.innerHTML.includes('hospital-map.html')) throw new Error('admin: map link missing');
      if (!d.body.innerHTML.includes('executive.html')) throw new Error('admin: executive link missing');
      if (!d.body.innerHTML.includes('exec-reports.html')) throw new Error('admin: exec-reports link missing');
    });
    await testPage('employee.html', (w, d) => {
      if (!d.getElementById('empCodeInput') && !d.querySelector('input')) throw new Error('employee: code input missing');
    });
    // دخول المسؤول محلياً ما يزال يعمل (كلمة المرور الافتراضية)
    {
      let html = fs.readFileSync(path.join(dir, 'admin.html'), 'utf8').replace(/<script src="https:[^"]+"[^>]*><\/script>/g, '');
      const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/admin.html', pretendToBeVisual: true });
      const w = dom.window;
      const code = ['config.js','script.js'].map(f => fs.readFileSync(path.join(dir,f),'utf8')).join('\n;\n');
      w.eval(code + '\n;window.__DB = DB;');
      const ok = await w.__DB.verifyPass("admin1234");
      if (!ok) throw new Error('admin: default password verification broken');
      console.log('OK: admin local auth');
    }
    console.log('REGRESSION OK: index, admin (all 11 sections + 2 new links), employee, auth');
  } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
})();
