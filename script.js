/* ======================= DATA CONFIG ======================= */
const HOSPITALS = ['مستشفى الطب النفسي','مستشفى الولادة والأطفال','مستشفى المدينة الرئيسي'];
const PERIODS = ['صباحية','مسائية','ليلية'];
const DEPARTMENTS = ['الطوارئ','العيادات الخارجية','التنويم','العناية المركزة','الجراحة العامة',
  'الباطنية','العظام','القلب','المسالك البولية','الأنف والأذن والحنجرة','النسائية والولادة',
  'الحضانة ورعاية حديثي الولادة','الأطفال','العلاج النفسي للبالغين','العلاج النفسي للأطفال والمراهقين',
  'علاج الإدمان','الخدمة الاجتماعية والنفسية','الصيدلية','المختبر','الأشعة','التغذية العلاجية',
  'التمريض','السجلات الطبية','مكافحة العدوى','الجودة وسلامة المرضى'];
const THRESHOLD_MIN = 0.90, THRESHOLD_WARN = 0.95;
const STORE_KEY = 'attendance_records_v1';
const PIN_KEY = 'attendance_pin_v1';
const THEME_KEY = 'attendance_theme_v1';

/* ======================= STATE ======================= */
let records = [];
let dashMonth = null;   // 'yyyy-mm' or 'all'
let recMonth = null;
let kpiScope = 'month'; // 'month' | 'week'
let editingId = null;   // id of record being edited, or null
let dashHosp = 'all', dashDept = 'all';

/* ======================= STORAGE ======================= */
function load(){ try{ records = JSON.parse(localStorage.getItem(STORE_KEY)||'[]'); }catch(e){ records=[]; } }
function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(records)); }

/* ======================= HELPERS ======================= */
const $ = id => document.getElementById(id);
const num = id => Math.max(0, parseInt($(id).value)||0);
const fmtDate = d => { const x=new Date(d); return x.toLocaleDateString('ar-SA-u-ca-gregory',{day:'numeric',month:'long',year:'numeric'}); };
const monthKey = d => d.slice(0,7);
const pct = v => (v*100).toFixed(1)+'%';
const normName = s => s.replace(/\s+/g,' ').trim();
function complianceColor(v){ if(v>=THRESHOLD_WARN) return 'var(--good)'; if(v>=THRESHOLD_MIN) return 'var(--warn)'; return 'var(--bad)'; }
function toast(msg,err){ const t=$('toast'); t.textContent=msg; t.className='toast show'+(err?' err':''); setTimeout(()=>t.className='toast',2200); }

/* ======================= MODAL (custom confirm) ======================= */
function confirmModal(title,msg,okText='تأكيد'){
  return new Promise(res=>{
    $('modalTitle').textContent=title; $('modalMsg').textContent=msg;
    $('modalOk').textContent=okText; $('modalBg').classList.add('on');
    const done=v=>{ $('modalBg').classList.remove('on');
      $('modalOk').onclick=null; $('modalCancel').onclick=null;
      $('modalBg').onclick=null; res(v); };
    $('modalOk').onclick=()=>done(true);
    $('modalCancel').onclick=()=>done(false);
    $('modalBg').onclick=e=>{ if(e.target===$('modalBg')) done(false); };
  });
}

/* ======================= POPULATE SELECTS ======================= */
function fillSelect(id,arr){ const s=$(id); s.innerHTML=arr.map(v=>`<option>${v}</option>`).join(''); }
fillSelect('f-hosp',HOSPITALS); fillSelect('f-period',PERIODS); fillSelect('f-dept',DEPARTMENTS);

/* ======================= ENTRY: steppers + live compliance ======================= */
document.querySelectorAll('.stepper button').forEach(b=>{
  b.addEventListener('click',()=>{ const inp=$(b.dataset.step);
    inp.value=Math.max(0,(parseInt(inp.value)||0)+parseInt(b.dataset.d));
    if(typeof clearFieldErrors==='function') clearFieldErrors(); livePreview(); });
});
['f-sched','f-present','f-absent','f-with','f-perm'].forEach(id=>$(id).addEventListener('input',()=>{
  if(typeof clearFieldErrors==='function') clearFieldErrors(); livePreview(); }));
function livePreview(){
  const s=num('f-sched'), p=num('f-present');
  const el=$('f-compliance'), word=$('f-comp-word');
  if(s===0){ el.textContent='—'; el.style.color='var(--muted)'; if(word) word.textContent=''; return; }
  const c=p/s; el.textContent=pct(c); el.style.color=complianceColor(c);
  if(word){ const col=complianceColor(c);
    const label = c>=THRESHOLD_WARN?'(جيد)' : c>=THRESHOLD_MIN?'(متوسط)' : '(منخفض)';
    word.textContent=label; word.style.color=col; }
}
// default date = today; header shows live weekday + date, auto-refreshing
function refreshToday(){
  const t=new Date();
  const opts={weekday:'long',day:'numeric',month:'long',year:'numeric'};
  $('todayLabel').textContent = t.toLocaleDateString('ar-SA-u-ca-gregory',opts);
}
(function(){ const iso=new Date().toISOString().slice(0,10);
  $('f-date').value=iso; refreshToday();
  // re-check every minute so the day flips automatically at midnight
  setInterval(()=>{ refreshToday();
    const nowIso=new Date().toISOString().slice(0,10);
    // if the user hasn't touched the date and it's still on an old "today", advance it
    if($('f-date').dataset.touched!=='1' && $('f-date').value!==nowIso) $('f-date').value=nowIso;
  },60000);
  $('f-date').addEventListener('change',()=>{$('f-date').dataset.touched='1';});
})();

/* ======================= SIGNATURE PAD ======================= */
const sigPad=$('sigPad'), sigCtx=sigPad.getContext('2d');
let sigDrawing=false, sigHasInk=false;
function sigResize(){
  const ratio=window.devicePixelRatio||1;
  const w=sigPad.offsetWidth, h=sigPad.offsetHeight;
  if(!w||!h) return; // canvas hidden (modal closed) — skip
  const prev=sigHasInk?sigPad.toDataURL():null;
  sigPad.width=w*ratio; sigPad.height=h*ratio;
  sigCtx.scale(ratio,ratio);
  sigCtx.lineWidth=2.2; sigCtx.lineCap='round'; sigCtx.lineJoin='round';
  sigCtx.strokeStyle='#0B3954';
  if(prev){ const img=new Image(); img.onload=()=>sigCtx.drawImage(img,0,0,w,h); img.src=prev; }
}
function sigPos(e){
  const r=sigPad.getBoundingClientRect();
  const p=e.touches?e.touches[0]:e;
  return {x:p.clientX-r.left, y:p.clientY-r.top};
}
function sigStart(e){ e.preventDefault(); sigDrawing=true;
  const {x,y}=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(x,y);
  if(!sigHasInk){ sigHasInk=true; $('sigHint').classList.add('hide');
    document.querySelector('.sig-wrap').classList.add('signed'); } }
function sigMove(e){ if(!sigDrawing) return; e.preventDefault();
  const {x,y}=sigPos(e); sigCtx.lineTo(x,y); sigCtx.stroke(); }
function sigEnd(){ sigDrawing=false; }
sigPad.addEventListener('mousedown',sigStart); sigPad.addEventListener('mousemove',sigMove);
window.addEventListener('mouseup',sigEnd);
sigPad.addEventListener('touchstart',sigStart,{passive:false});
sigPad.addEventListener('touchmove',sigMove,{passive:false});
sigPad.addEventListener('touchend',sigEnd);
$('sigClear').addEventListener('click',()=>{ clearSig(); });
function clearSig(){ sigCtx.clearRect(0,0,sigPad.width,sigPad.height); sigHasInk=false;
  $('sigHint').classList.remove('hide'); document.querySelector('.sig-wrap').classList.remove('signed'); }
setTimeout(sigResize,60); window.addEventListener('resize',sigResize);

/* ======================= SAVE RECORD ======================= */
function clearFieldErrors(){
  document.querySelectorAll('.invalid').forEach(el=>el.classList.remove('invalid'));
  const ne=$('numErr'); ne.classList.remove('show'); ne.textContent='';
}
function flagField(id){ const el=$(id); if(!el) return;
  const st=el.closest('.stepper'); (st||el).classList.add('invalid');
  el.scrollIntoView({behavior:'smooth',block:'center'}); }
function showNumErr(msg){ const ne=$('numErr'); ne.textContent=msg; ne.classList.add('show');
  ne.scrollIntoView({behavior:'smooth',block:'center'}); }

$('saveBtn').addEventListener('click',async ()=>{
  clearFieldErrors();
  const date=$('f-date').value, by=$('f-by').value.trim();
  const hosp=$('f-hosp').value, period=$('f-period').value, dept=$('f-dept').value;
  const sched=num('f-sched'), present=num('f-present');
  const absent=num('f-absent'), withdraw=num('f-with'), perm=num('f-perm'), leave=num('f-leave');
  if(!date){ toast('أدخل التاريخ',true); flagField('f-date'); return; }
  if(sched===0){ toast('أدخل عدد العاملين المجدولين',true); flagField('f-sched'); return; }
  if(present>sched){ showNumErr('⚠️ عدد الحاضرين أكبر من المجدولين — راجع الأعداد.'); flagField('f-present'); flagField('f-sched'); return; }
  if(present+absent>sched){ showNumErr('⚠️ الحضور + الغياب يتجاوز عدد المجدولين.'); flagField('f-present'); flagField('f-absent'); return; }
  if(present+absent+withdraw+perm>sched){ showNumErr('⚠️ مجموع (حضور + غياب + انسحاب + استئذان) يتجاوز المجدولين.'); flagField('f-present'); return; }
  if(!by){ toast('أدخل اسم مُدخل البيانات',true); flagField('f-by'); return; }

  // duplicate detection (same date+hosp+period+dept), ignore the record being edited
  const dup = records.find(r=> r.id!==editingId && r.date===date && r.hosp===hosp
    && r.period===period && r.dept===dept);
  if(dup && editingId===null){
    if(dup.status==='approved'){
      toast('هذا القسم معتمد بالفعل في هذه الفترة',true); return;
    }
    const ok=await confirmModal('تسجيل مكرر',
      `يوجد تسجيل لنفس (${dept} • ${period}) في هذا التاريخ. هل تريد تحديثه بدل إنشاء تسجيل جديد؟`,
      'تحديث الموجود');
    if(ok){ editingId=dup.id; } else { return; }
  }

  const payload={ date, hosp, period, dept, sched, present, absent, withdraw, perm, leave,
    names:normName($('f-names').value), notes:$('f-notes').value.trim(), by };

  if(editingId!==null){
    const i=records.findIndex(r=>r.id===editingId);
    if(i>-1){
      if(records[i].status==='approved'){ toast('لا يمكن تعديل تسجيل معتمد',true); return; }
      records[i]={...records[i],...payload, editedAt:new Date().toISOString()};
      // editing a previously rejected entry sends it back for review
      if(records[i].review && records[i].review.state==='rejected'){
        records[i].review={state:'none',by:'',note:'',at:''};
      }
    }
    toast('✓ تم تحديث التسجيل');
  }else{
    records.push({ id:Date.now(), ...payload, status:'pending',
      deputy:'', signature:'', savedAt:new Date().toISOString(),
      review:{state:'none',by:'',note:'',at:''} });
    toast('✓ حُفظ — بانتظار اعتماد النائب');
  }
  save();
  localStorage.setItem('attendance_lastby_v1', by);
  exitEditMode();
  ['f-present','f-absent','f-with','f-perm','f-leave'].forEach(id=>$(id).value=0);
  $('f-sched').value=0; $('f-names').value=''; $('f-notes').value=''; livePreview();
  renderAll();
});

/* ======================= EDIT MODE ======================= */
function enterEditMode(id){
  const r=records.find(x=>x.id==id); if(!r) return;
  if(r.status==='approved'){ toast('لا يمكن تعديل تسجيل معتمد',true); return; }
  if(typeof clearFieldErrors==='function') clearFieldErrors();
  editingId=r.id;
  $('f-date').value=r.date; $('f-date').dataset.touched='1';
  $('f-hosp').value=r.hosp; $('f-period').value=r.period; $('f-dept').value=r.dept;
  $('f-sched').value=r.sched; $('f-present').value=r.present;
  $('f-absent').value=r.absent; $('f-with').value=r.withdraw;
  $('f-perm').value=r.perm; $('f-leave').value=r.leave;
  $('f-names').value=r.names||''; $('f-notes').value=r.notes||'';
  $('f-by').value=r.by||'';
  $('saveBtn').textContent='💾 حفظ التعديل';
  $('editBanner').classList.add('on');
  livePreview();
  switchView('entry');
}
function exitEditMode(){
  editingId=null; $('saveBtn').textContent='💾 حفظ التسجيل';
  $('editBanner').classList.remove('on');
}
$('cancelEdit').addEventListener('click',()=>{
  exitEditMode();
  ['f-present','f-absent','f-with','f-perm','f-leave'].forEach(id=>$(id).value=0);
  $('f-sched').value=0; $('f-names').value=''; $('f-notes').value=''; livePreview();
  toast('أُلغي التعديل');
});

/* ======================= NAV ======================= */
function switchView(view){
  if(!view) return;
  document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.view===view));
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  const target=$('view-'+view);
  if(target) target.classList.add('active');
  if(view==='entry'){ const u=(typeof currentUser==='function')?currentUser():null;
    if(u && $('f-by')){ $('f-by').value=u.name; } }
  if(view==='dash') renderDash();
  if(view==='records') renderRecords();
  if(view==='approve') renderApproval();
  if(view==='export') updateStoreNote();
  if(view==='mytasks') renderMyTasks();
  if(view==='supervise') renderSupervise();
  if(view==='manage'){ renderUsers(); renderAllTasks(); }
  window.scrollTo(0,0);
}
document.querySelectorAll('.nav button').forEach(b=>{
  let lastFire=0;
  const go=e=>{ e.preventDefault(); e.stopPropagation();
    const now=Date.now(); if(now-lastFire<350) return; lastFire=now;
    switchView(b.dataset.view); };
  b.addEventListener('pointerup',go);
  b.addEventListener('click',go);
});

/* KPI scope toggle (weekly / monthly) */
document.querySelectorAll('#kpiToggle button').forEach(b=>{
  let last=0;
  const go=e=>{ e.preventDefault();
    const now=Date.now(); if(now-last<350) return; last=now;
    kpiScope=b.dataset.scope;
    document.querySelectorAll('#kpiToggle button').forEach(x=>x.classList.toggle('active',x===b));
    renderKPIs(); };
  b.addEventListener('pointerup',go);
  b.addEventListener('click',go);
});

/* ======================= MONTH FILTERS ======================= */
function getMonths(){ const set=new Set(records.map(r=>monthKey(r.date))); return [...set].sort().reverse(); }
function buildFilters(containerId, current, onPick){
  const months=getMonths(); const c=$(containerId); c.innerHTML='';
  const mk=(key,label)=>{ const chip=document.createElement('button');
    chip.className='chip'+(current===key?' active':''); chip.textContent=label;
    chip.onclick=()=>onPick(key); c.appendChild(chip); };
  mk('all','كل الأشهر');
  months.forEach(m=>{ const d=new Date(m+'-01');
    mk(m, d.toLocaleDateString('ar-SA-u-ca-gregory',{month:'long',year:'numeric'})); });
}

/* ======================= AGGREGATION ======================= */
function filtered(month){ return month==='all'||!month ? records : records.filter(r=>monthKey(r.date)===month); }
function sum(arr,f){ return arr.reduce((a,r)=>a+f(r),0); }

/* ======================= KPI RATES ======================= */
function prevMonthKey(mk){ const d=new Date(mk+'-01'); d.setMonth(d.getMonth()-1);
  return d.toISOString().slice(0,7); }
function compOf(arr){ const s=sum(arr,r=>r.sched); return s?sum(arr,r=>r.present)/s:0; }

// week range helpers (week = Saturday..Friday, common in SA)
function dateOnly(s){ return new Date(s+'T00:00:00'); }
function weekStart(d){ const x=new Date(d); const day=x.getDay(); // 0=Sun..6=Sat
  const diff=(day+1)%7; // days since Saturday
  x.setDate(x.getDate()-diff); x.setHours(0,0,0,0); return x; }
function inRange(r,start,end){ const t=dateOnly(r.date).getTime();
  return t>=start.getTime() && t<=end.getTime(); }
function fmtShort(d){ return d.toLocaleDateString('ar-SA-u-ca-gregory',{day:'numeric',month:'short'}); }

function renderKPIs(){
  const list=$('kpiList'), note=$('kpiScopeNote');
  // pick reference date: latest record within current month filter, else latest overall
  const pool = filtered(dashMonth);
  let data, prevData, trendLabel, scopeText;

  if(kpiScope==='week'){
    if(!pool.length){ note.textContent=''; list.innerHTML=emptyKPI(); return; }
    const latest = pool.reduce((a,r)=> r.date>a?r.date:a, pool[0].date);
    const ws = weekStart(dateOnly(latest));
    const we = new Date(ws); we.setDate(we.getDate()+6); we.setHours(23,59,59,999);
    const pws = new Date(ws); pws.setDate(pws.getDate()-7);
    const pwe = new Date(ws); pwe.setDate(pwe.getDate()-1); pwe.setHours(23,59,59,999);
    data = pool.filter(r=>inRange(r,ws,we));
    prevData = pool.filter(r=>inRange(r,pws,pwe));
    trendLabel='عن الأسبوع السابق';
    scopeText=`الأسبوع: ${fmtShort(ws)} — ${fmtShort(we)}`;
  } else {
    data = pool;
    prevData = (dashMonth && dashMonth!=='all') ? filtered(prevMonthKey(dashMonth)) : [];
    trendLabel='عن الشهر السابق';
    scopeText = (dashMonth==='all'||!dashMonth) ? 'كل الأشهر' :
      dateOnly(dashMonth+'-01').toLocaleDateString('ar-SA-u-ca-gregory',{month:'long',year:'numeric'});
  }
  note.textContent=scopeText;

  const sched=sum(data,r=>r.sched), present=sum(data,r=>r.present),
        absent=sum(data,r=>r.absent), withd=sum(data,r=>r.withdraw),
        perm=sum(data,r=>r.perm), leave=sum(data,r=>r.leave);
  if(!sched){ list.innerHTML=emptyKPI(); return; }

  const rComp=present/sched, rAbsent=absent/sched, rWith=withd/sched,
        rPerm=perm/sched, rLeave=leave/sched, rAttend=present/sched;

  let trendHTML='';
  if(sum(prevData,r=>r.sched)>0){
    const diff=rComp-compOf(prevData); const up=diff>=0;
    trendHTML=`<div class="ki-trend" style="color:${up?'var(--good)':'var(--bad)'}">`+
      `${up?'▲':'▼'} ${Math.abs(diff*100).toFixed(1)}% ${trendLabel}</div>`;
  }

  const hstats=HOSPITALS.map(h=>{ const d=data.filter(r=>r.hosp===h);
    const s=sum(d,r=>r.sched); return {h, s, c:s?sum(d,r=>r.present)/s:0}; }).filter(x=>x.s>0);
  let best='—', worst='—';
  if(hstats.length){ best=hstats.reduce((a,b)=>b.c>a.c?b:a).h;
    worst=hstats.reduce((a,b)=>b.c<a.c?b:a).h; }

  const item=(lbl,val,color,trend)=>`<div class="kpi-item"><div class="ki-lbl">${lbl}</div>`+
    `<div class="ki-val" style="color:${color}">${val}</div>${trend||''}</div>`;
  const full=(lbl,val,color)=>`<div class="kpi-item full"><span class="ki-lbl">${lbl}</span>`+
    `<span class="ki-val" style="color:${color}">${val}</span></div>`;
  const absColor = rAbsent<=0.05?'var(--good)':rAbsent<=0.10?'var(--warn)':'var(--bad)';

  list.innerHTML =
    item('نسبة الالتزام العام', pct(rComp), complianceColor(rComp), trendHTML)+
    item('معدل الحضور', pct(rAttend), complianceColor(rAttend))+
    item('نسبة الغياب', pct(rAbsent), absColor)+
    item('نسبة الانسحاب', pct(rWith), 'var(--gold)')+
    item('نسبة الاستئذان', pct(rPerm), 'var(--gold)')+
    item('نسبة الإجازات', pct(rLeave), 'var(--teal)')+
    full('أفضل مستشفى التزاماً', best, 'var(--good)')+
    full('أقل مستشفى التزاماً', worst, 'var(--bad)');
}
function emptyKPI(){ return '<p style="grid-column:1/-1;font-size:12.5px;color:var(--muted);margin:0">لا توجد بيانات لحساب المؤشرات</p>'; }

/* ======================= DASHBOARD ======================= */
function buildDashSubFilters(){
  const hs=$('dashHospFilter'), ds=$('dashDeptFilter');
  hs.innerHTML='<option value="all">كل المستشفيات</option>'+HOSPITALS.map(h=>`<option value="${h}">${h}</option>`).join('');
  ds.innerHTML='<option value="all">كل الأقسام</option>'+DEPARTMENTS.map(d=>`<option value="${d}">${d}</option>`).join('');
  hs.value=dashHosp; ds.value=dashDept;
  hs.onchange=()=>{ dashHosp=hs.value; renderDash(); };
  ds.onchange=()=>{ dashDept=ds.value; renderDash(); };
}
function dashData(){
  let d=filtered(dashMonth);
  if(dashHosp!=='all') d=d.filter(r=>r.hosp===dashHosp);
  if(dashDept!=='all') d=d.filter(r=>r.dept===dashDept);
  return d;
}
function renderDash(){
  const months=getMonths();
  if(dashMonth===null) dashMonth = months[0]||'all';
  buildFilters('monthFilters',dashMonth,k=>{dashMonth=k;renderDash();});
  buildDashSubFilters();
  const data=dashData();
  const sched=sum(data,r=>r.sched), present=sum(data,r=>r.present);
  const absent=sum(data,r=>r.absent), withd=sum(data,r=>r.withdraw), perm=sum(data,r=>r.perm);
  const comp = sched? present/sched : 0;

  $('k-present').textContent=present;
  $('k-absent').textContent=absent;
  $('k-with').textContent=withd;
  $('k-perm').textContent=perm;
  const cv=$('k-comp'); cv.textContent = sched? pct(comp):'—'; cv.style.color=complianceColor(comp);

  // alert
  const ab=$('alertBox'), at=$('alertText');
  if(!sched){ ab.className='alert none'; ab.querySelector('.ic').textContent='📊'; at.textContent='لا توجد بيانات لهذه الفترة'; }
  else if(comp>=THRESHOLD_WARN){ ab.className='alert good'; ab.querySelector('.ic').textContent='🟢'; at.textContent='ممتاز: نسبة الالتزام ضمن المستوى المطلوب'; }
  else if(comp>=THRESHOLD_MIN){ ab.className='alert warn'; ab.querySelector('.ic').textContent='🟠'; at.textContent='تحذير: نسبة الالتزام دون المستوى المستهدف'; }
  else { ab.className='alert bad'; ab.querySelector('.ic').textContent='🔴'; at.textContent='خطر: نسبة الالتزام أقل من الحد الأدنى المقبول'; }
  // badge
  const badge=$('k-comp-badge');
  if(!sched){ badge.style.display='none'; }
  else{ badge.style.display='inline-block';
    if(comp>=THRESHOLD_WARN){badge.textContent='جيد';badge.style.background='var(--good-bg)';badge.style.color='var(--good)';}
    else if(comp>=THRESHOLD_MIN){badge.textContent='متوسط';badge.style.background='var(--warn-bg)';badge.style.color='var(--warn)';}
    else{badge.textContent='منخفض';badge.style.background='var(--bad-bg)';badge.style.color='var(--bad)';}
  }

  // ============ KPI rates ============
  renderKPIs();

  // ============ smart alerts ============
  renderSmartAlerts(data);

  // ============ trend chart ============
  renderTrend(data);

  // hospital bars
  const hb=$('hospBars'); hb.innerHTML='';
  HOSPITALS.forEach(h=>{ const d=data.filter(r=>r.hosp===h);
    const s=sum(d,r=>r.sched), p=sum(d,r=>r.present); const c=s?p/s:0;
    hb.innerHTML+=barRow(h, c, complianceColor(c), s?pct(c):'لا بيانات', s===0);
  });

  // dept violations (top 6)
  const db=$('deptBars'); db.innerHTML='';
  const deptMap={};
  data.forEach(r=>{ const v=r.absent+r.withdraw+r.perm;
    deptMap[r.dept]=(deptMap[r.dept]||0)+v; });
  const deptArr=Object.entries(deptMap).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxV=deptArr.length?deptArr[0][1]:1;
  if(!deptArr.length){ db.innerHTML='<p style="font-size:12.5px;color:var(--muted);margin:0">لا توجد مخالفات مسجّلة</p>'; }
  else deptArr.forEach(([n,v])=>{ db.innerHTML+=barRow(n, v/maxV, 'var(--warn)', v+' مخالفة', false); });

  // offenders from names field (normalized)
  const off=$('offenders'); off.innerHTML='';
  const nameMap={};
  data.forEach(r=>{ if(r.names) r.names.split(/[،,]/).map(s=>normName(s)).filter(Boolean)
    .forEach(nm=>{ nameMap[nm]=(nameMap[nm]||0)+1; }); });
  const offArr=Object.entries(nameMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
  if(!offArr.length){ off.innerHTML='<p style="font-size:12.5px;color:var(--muted);margin:0">لم تُسجَّل أسماء متغيبين بعد</p>'; }
  else{ const mx=offArr[0][1];
    offArr.forEach(([n,v],i)=>{ off.innerHTML+=
      `<div class="bar-row"><div class="bar-head"><span class="name">${i+1}. ${n}</span>`+
      `<span class="pct" style="color:var(--bad)">${v} مرة</span></div>`+
      `<div class="bar-track"><div class="bar-fill" style="width:${(v/mx*100)}%;background:var(--bad)"></div></div></div>`; });
  }
}
function barRow(name,frac,color,label,muted){
  return `<div class="bar-row"><div class="bar-head"><span class="name">${name}</span>`+
    `<span class="pct" style="color:${muted?'var(--muted)':color}">${label}</span></div>`+
    `<div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,frac*100)}%;background:${color}"></div></div></div>`;
}

/* ======================= SMART ALERTS ======================= */
function renderSmartAlerts(data){
  const box=$('smartAlerts'); const out=[];

  // 1) pending approvals (global, not filtered)
  const pend=pendingCount();
  if(pend>0){
    out.push(`<div class="salert warn"><span class="si">✍️</span>
      <span>لديك ${pend} ${pend===1?'دفعة':'دفعات'} بانتظار اعتماد النائب الإداري.</span>
      <button data-go="approve">اعتماد الآن</button></div>`);
  }

  // 2) departments below minimum threshold in current view
  const deptStats={};
  data.forEach(r=>{ if(!deptStats[r.dept]) deptStats[r.dept]={s:0,p:0};
    deptStats[r.dept].s+=r.sched; deptStats[r.dept].p+=r.present; });
  const low=Object.entries(deptStats).filter(([,v])=>v.s>0 && v.p/v.s<THRESHOLD_MIN)
    .map(([d,v])=>({d,c:v.p/v.s})).sort((a,b)=>a.c-b.c);
  if(low.length){
    const names=low.slice(0,3).map(x=>`${x.d} (${pct(x.c)})`).join('، ');
    out.push(`<div class="salert bad"><span class="si">⚠️</span>
      <span>${low.length} ${low.length===1?'قسم':'أقسام'} تحت الحد الأدنى (90%): ${names}${low.length>3?' وغيرها':''}.</span></div>`);
  }

  // 3) consecutive declining days (last 3 points trend down)
  const byDay={};
  data.forEach(r=>{ const k=r.date; if(!byDay[k])byDay[k]={s:0,p:0}; byDay[k].s+=r.sched; byDay[k].p+=r.present; });
  const series=Object.entries(byDay).filter(([,v])=>v.s>0).map(([d,v])=>({d,c:v.p/v.s}))
    .sort((a,b)=>a.d.localeCompare(b.d));
  if(series.length>=3){
    const last3=series.slice(-3);
    if(last3[0].c>last3[1].c && last3[1].c>last3[2].c){
      out.push(`<div class="salert warn"><span class="si">📉</span>
        <span>الالتزام في انخفاض متواصل آخر 3 أيام مسجّلة. يُنصح بمتابعة الأقسام المتأثرة.</span></div>`);
    }
  }

  box.innerHTML=out.join('');
  box.querySelectorAll('button[data-go]').forEach(b=>b.onclick=()=>switchView(b.dataset.go));
}

/* ======================= TREND CHART (pure SVG, offline) ======================= */
function renderTrend(data){
  const box=$('trendChart');
  // aggregate compliance per day, sorted ascending
  const byDay={};
  data.forEach(r=>{ const k=r.date; if(!byDay[k]) byDay[k]={s:0,p:0}; byDay[k].s+=r.sched; byDay[k].p+=r.present; });
  let pts=Object.entries(byDay).filter(([,v])=>v.s>0)
    .map(([d,v])=>({d, c:v.p/v.s})).sort((a,b)=>a.d.localeCompare(b.d));
  // keep last 14 points for readability
  pts=pts.slice(-14);
  if(pts.length<2){
    box.innerHTML='<p style="font-size:12.5px;color:var(--muted);margin:8px 0;text-align:center">يلزم يومان على الأقل لرسم الاتجاه</p>';
    return;
  }
  const W=480,H=180,pad={t:16,r:14,b:30,l:38};
  const iw=W-pad.l-pad.r, ih=H-pad.t-pad.b;
  const x=i=>pad.l + (i/(pts.length-1))*iw;
  const y=v=>pad.t + (1-v)*ih;             // 0..1 mapped (full range)
  const linePts=pts.map((p,i)=>`${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
  // gridlines at 0,50,90,95,100
  const grid=[0,.5,.9,1].map(v=>`<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${W-pad.r}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`+
    `<text x="${pad.l-6}" y="${(y(v)+3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${Math.round(v*100)}</text>`).join('');
  const threshY=y(THRESHOLD_MIN).toFixed(1);
  const dots=pts.map((p,i)=>`<circle cx="${x(i).toFixed(1)}" cy="${y(p.c).toFixed(1)}" r="3" fill="${complianceColor(p.c)}"/>`).join('');
  // x labels: first, middle, last
  const lab=idx=>{ const dd=dateOnly(pts[idx].d); return `<text x="${x(idx).toFixed(1)}" y="${H-10}" text-anchor="middle" font-size="9" fill="var(--muted)">${fmtShort(dd)}</text>`; };
  const xlabels=[0,Math.floor((pts.length-1)/2),pts.length-1].map(lab).join('');
  box.innerHTML=`<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${grid}
    <line x1="${pad.l}" y1="${threshY}" x2="${W-pad.r}" y2="${threshY}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="5 4" opacity=".7"/>
    <polyline points="${linePts}" fill="none" stroke="var(--teal)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${xlabels}
  </svg>`;
}

/* ======================= RECORDS ======================= */
function renderRecords(){
  const months=getMonths();
  if(recMonth===null) recMonth='all';
  buildFilters('recFilters',recMonth,k=>{recMonth=k;renderRecords();});
  const data=filtered(recMonth).slice()
    .filter(r=>{ const u=(typeof currentUser==='function')?currentUser():null;
      if(u && u.role==='staff') return r.by===u.name; return true; })
    .sort((a,b)=> b.date.localeCompare(a.date)||b.id-a.id);
  $('recCount').textContent = data.length? `${data.length} تسجيل` : '';
  const list=$('recordsList');
  if(!data.length){ list.innerHTML=`<div class="empty"><div class="e-ic">📋</div>
    <h3>لا توجد تسجيلات</h3><p>ابدأ بإضافة تسجيل من تبويب «تسجيل»</p></div>`; return; }
  list.innerHTML=data.map(r=>{
    const c=r.sched?r.present/r.sched:0;
    const isAppr=r.status==='approved';
    const statusPill=isAppr
      ? '<span class="r-status approved">✓ معتمد</span>'
      : '<span class="r-status pending">⏳ بانتظار الاعتماد</span>';
    const rv=r.review||{state:'none'};
    let reviewPill='';
    if(rv.state==='approved') reviewPill='<span class="review-pill approved">✓ راجعه المسؤول</span>';
    else if(rv.state==='rejected') reviewPill='<span class="review-pill rejected">↩️ أُرجع للتصحيح</span>';
    const reviewNote = rv.state==='rejected'
      ? `<div class="review-note rejected">↩️ ملاحظة المسؤول (${rv.by||''}): ${rv.note||''}</div>` : '';
    return `<div class="rec"><div class="r-top"><span class="r-hosp">${r.hosp}${statusPill}${reviewPill}</span>
      <span class="r-date">${fmtDate(r.date)}</span></div>
      <div class="r-meta">${r.dept} • ${r.period} • أدخلها: ${r.by}${r.deputy?` • النائب: ${r.deputy}`:''}</div>
      <div class="r-stats">
        <span class="tag c">حضور ${r.present}/${r.sched}</span>
        <span class="tag">التزام ${r.sched?pct(c):'—'}</span>
        ${r.absent?`<span class="tag a">غياب ${r.absent}</span>`:''}
        ${r.withdraw?`<span class="tag">انسحاب ${r.withdraw}</span>`:''}
        ${r.perm?`<span class="tag">استئذان ${r.perm}</span>`:''}
        ${r.leave?`<span class="tag">إجازات ${r.leave}</span>`:''}
      </div>
      ${reviewNote}
      ${r.signature?`<div class="r-sig"><span class="r-sig-lbl">توقيع النائب</span><img src="${r.signature}" alt="توقيع"></div>`:''}
      ${isAppr?'' :`<div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-ghost btn-sm edit" data-id="${r.id}" style="flex:1">✏️ تعديل</button>
        <button class="del" data-id="${r.id}" style="flex:1">حذف</button>
      </div>`}</div>`;
  }).join('');
  list.querySelectorAll('.edit').forEach(b=>b.onclick=()=>enterEditMode(b.dataset.id));
  list.querySelectorAll('.del').forEach(b=>b.onclick=async ()=>{
    const ok=await confirmModal('حذف التسجيل','سيُحذف هذا التسجيل نهائياً. متابعة؟','حذف');
    if(ok){ records=records.filter(r=>r.id!=b.dataset.id); save(); renderAll(); toast('تم الحذف'); }
  });
}

/* ======================= APPROVAL (batch signing) =======================
   batch = date + hospital + period. One signature approves all its departments. */
const batchKey = r => `${r.date}|${r.hosp}|${r.period}`;
function getBatches(onlyPending){
  const map={};
  records.forEach(r=>{ const k=batchKey(r);
    if(!map[k]) map[k]={date:r.date,hosp:r.hosp,period:r.period,items:[]};
    map[k].items.push(r); });
  let arr=Object.values(map);
  if(onlyPending) arr=arr.filter(b=>b.items.some(r=>r.status!=='approved'));
  return arr.sort((a,b)=> b.date.localeCompare(a.date) || a.hosp.localeCompare(b.hosp));
}
function pendingCount(){ return getBatches(true).length; }
function refreshNavBadge(){ const n=pendingCount(); const el=$('navBadge');
  if(n>0){ el.textContent=n; el.classList.add('on'); } else el.classList.remove('on'); }

let signingBatch=null; // {date,hosp,period}
function renderApproval(){
  refreshNavBadge();
  const batches=getBatches(false);
  const pend=batches.filter(b=>b.items.some(r=>r.status!=='approved'));
  $('apprCount').textContent = pend.length? `${pend.length} بانتظار الاعتماد` : 'لا شيء معلّق';
  const list=$('batchList');
  if(!batches.length){
    list.innerHTML=`<div class="empty-appr"><div class="e-ic">✅</div>
      <h3>لا توجد دفعات</h3><p>سجّل الأقسام أولاً من تبويب «تسجيل»</p></div>`; return;
  }
  // pending first, then approved
  batches.sort((a,b)=>{
    const ap=a.items.every(r=>r.status==='approved'), bp=b.items.every(r=>r.status==='approved');
    return (ap-bp) || b.date.localeCompare(a.date);
  });
  list.innerHTML=batches.map(b=>{
    const approved=b.items.every(r=>r.status==='approved');
    const s=sum(b.items,r=>r.sched), p=sum(b.items,r=>r.present); const c=s?p/s:0;
    const sig=b.items.find(r=>r.signature);
    const chips=b.items.map(r=>{ const cc=r.sched?r.present/r.sched:0;
      return `<span class="d-chip">${r.dept} <b>${r.sched?pct(cc):'—'}</b></span>`; }).join('');
    return `<div class="batch ${approved?'approved':''}">
      <div class="batch-head">
        <div><div class="b-hosp">${b.hosp}</div>
          <div class="b-meta">${fmtDate(b.date)} • فترة ${b.period} • ${b.items.length} قسم</div></div>
        <span class="batch-status ${approved?'approved':'pending'}">${approved?'✓ معتمدة':'⏳ بانتظار'}</span>
      </div>
      <div class="batch-depts">${chips}</div>
      <div class="batch-foot">
        <span class="b-comp" style="color:${complianceColor(c)}">الالتزام: ${s?pct(c):'—'}</span>
        ${approved
          ? `<div class="batch-sig">${sig?`<img src="${sig.signature}" alt="توقيع">`:''}<span>${b.items[0].deputy||''}</span></div>`
          : `<button class="btn-approve" data-k="${batchKey(b.items[0])}">✍️ اعتماد ووقّع</button>`}
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.btn-approve').forEach(btn=>btn.onclick=()=>openSign(btn.dataset.k));
}

function openSign(key){
  const [date,hosp,period]=key.split('|');
  signingBatch={date,hosp,period};
  const items=records.filter(r=>batchKey(r)===key);
  const pendItems=items.filter(r=>r.status!=='approved');
  $('signTitle').textContent='اعتماد نهاية الفترة';
  $('signSub').innerHTML=`<b>${hosp}</b> • ${fmtDate(date)} • فترة ${period}<br>`+
    `سيُعتمد <b>${pendItems.length}</b> قسم بهذا التوقيع الواحد: ${pendItems.map(r=>r.dept).join('، ')}`;
  $('a-deputy').value='';
  clearSig();
  $('signBg').classList.add('on');
  // canvas was hidden → size it now
  setTimeout(sigResize,80);
}
$('signCancel').onclick=()=>{ $('signBg').classList.remove('on'); signingBatch=null; };
$('signConfirm').onclick=()=>{
  if(!signingBatch) return;
  const deputy=$('a-deputy').value.trim();
  if(!deputy){ toast('أدخل اسم النائب الإداري',true); return; }
  if(!sigHasInk){ toast('التوقيع مطلوب',true); return; }
  const sigData=sigPad.toDataURL('image/png');
  const key=`${signingBatch.date}|${signingBatch.hosp}|${signingBatch.period}`;
  const stamp=new Date().toISOString();
  let n=0;
  records.forEach(r=>{ if(batchKey(r)===key && r.status!=='approved'){
    r.status='approved'; r.deputy=deputy; r.signature=sigData; r.approvedAt=stamp; n++; } });
  save();
  $('signBg').classList.remove('on'); signingBatch=null;
  toast(`✓ تم اعتماد ${n} قسم بتوقيع واحد`);
  renderApproval(); renderAll();
};

/* ======================= EXPORT ======================= */
const COLS=['التاريخ','المستشفى','القسم','الفترة','العاملون المجدولون','الحاضرون','الغياب',
  'أسماء المتغيبين','الانسحاب','الإجازات','الاستئذان','الملاحظات','نسبة الالتزام','مُدخل البيانات',
  'النائب الإداري','التوقيع','الحالة'];
function rowVals(r){ const c=r.sched?(r.present/r.sched):0;
  return [r.date,r.hosp,r.dept,r.period,r.sched,r.present,r.absent,r.names||'',
    r.withdraw,r.leave,r.perm,r.notes||'',(c*100).toFixed(1)+'%',r.by,
    r.deputy||'', r.signature?'موقّع ✓':'—', r.status==='approved'?'معتمد':'بانتظار الاعتماد']; }
function exportCSV(){
  if(!records.length){ toast('لا توجد بيانات للتصدير',true); return; }
  const rows=records.slice().sort((a,b)=>a.date.localeCompare(b.date));
  let csv='\uFEFF'+COLS.join(',')+'\n';
  rows.forEach(r=>{ csv+=rowVals(r).map(v=>{
    const s=String(v).replace(/"/g,'""'); return /[",\n]/.test(s)?`"${s}"`:s; }).join(',')+'\n'; });
  downloadBlob(csv,'text/csv;charset=utf-8','تسجيلات_الانتظام_'+new Date().toISOString().slice(0,10)+'.csv');
  toast('✓ تم تصدير CSV');
}
function exportExcel(){
  if(!records.length){ toast('لا توجد بيانات للتصدير',true); return; }
  const rows=records.slice().sort((a,b)=>a.date.localeCompare(b.date));
  // SpreadsheetML (.xls) – opens directly in Excel with RTL + styling
  let body=rows.map(r=>'<Row>'+rowVals(r).map((v,i)=>{
    const t=(i>=4&&i<=10)?'Number':'String';
    const val=String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<Cell><Data ss:Type="${t==='Number'&&!isNaN(v)&&i!==12?'Number':'String'}">${val}</Data></Cell>`;
  }).join('')+'</Row>').join('');
  const head='<Row>'+COLS.map(c=>`<Cell ss:StyleID="h"><Data ss:Type="String">${c}</Data></Cell>`).join('')+'</Row>';
  const xml=`<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1" ss:Color="#FFFFFF"/>
<Interior ss:Color="#0B3954" ss:Pattern="Solid"/>
<Alignment ss:Horizontal="Center"/></Style></Styles>
<Worksheet ss:Name="تسجيلات الانتظام"><Table>${head}${body}</Table>
<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><DisplayRightToLeft/></WorksheetOptions>
</Worksheet></Workbook>`;
  downloadBlob(xml,'application/vnd.ms-excel','تسجيلات_الانتظام_'+new Date().toISOString().slice(0,10)+'.xls');
  toast('✓ تم تصدير Excel');
}
function downloadBlob(content,type,name){
  const blob=new Blob([content],{type}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('expCsv').onclick=exportCSV; $('expExcel').onclick=exportExcel;

/* ======================= IMPORT (legacy CSV) =======================
   COLS order: 0التاريخ 1المستشفى 2القسم 3الفترة 4المجدولون 5الحاضرون 6الغياب
   7أسماء 8الانسحاب 9الإجازات 10الاستئذان 11الملاحظات 12نسبة 13مُدخل 14النائب 15التوقيع */
$('importFile').onchange=e=>{
  const file=e.target.files[0]; if(!file) return;
  const rd=new FileReader();
  rd.onload=()=>{
    try{
      let txt=rd.result.replace(/^\uFEFF/,''); const lines=txt.split(/\r?\n/).filter(l=>l.trim());
      let added=0;
      for(let i=1;i<lines.length;i++){ const c=parseCSVLine(lines[i]); if(c.length<14) continue;
        records.push({ id:Date.now()+i, date:c[0],hosp:c[1],dept:c[2],period:c[3],
          sched:+c[4]||0,present:+c[5]||0,absent:+c[6]||0,names:normName(c[7]||''),
          withdraw:+c[8]||0,leave:+c[9]||0,perm:+c[10]||0,notes:c[11]||'',by:c[13]||'',
          deputy:c[14]||'',signature:'', status:(c[14]&&c[14].trim())?'approved':'pending' });
        added++; }
      save(); renderAll(); toast(`✓ تم استيراد ${added} تسجيل`);
    }catch(err){ toast('تعذّر قراءة الملف',true); }
    e.target.value='';
  };
  rd.readAsText(file);
};
function parseCSVLine(line){ const out=[]; let cur='',q=false;
  for(let i=0;i<line.length;i++){ const ch=line[i];
    if(q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else{ if(ch==='"')q=true; else if(ch===','){out.push(cur);cur='';} else cur+=ch; } }
  out.push(cur); return out; }

/* ======================= FULL JSON BACKUP / RESTORE ======================= */
$('backupExport').onclick=()=>{
  if(!records.length){ toast('لا توجد بيانات للنسخ',true); return; }
  const payload={ app:'attendance', version:1, exportedAt:new Date().toISOString(), records };
  downloadBlob(JSON.stringify(payload),'application/json',
    'نسخة_احتياطية_الانتظام_'+new Date().toISOString().slice(0,10)+'.json');
  toast('✓ تم حفظ نسخة احتياطية كاملة');
};
$('backupImportBtn').onclick=()=>$('backupFile').click();
$('backupFile').onchange=e=>{
  const file=e.target.files[0]; if(!file) return;
  const rd=new FileReader();
  rd.onload=async ()=>{
    try{
      const obj=JSON.parse(rd.result);
      const incoming=Array.isArray(obj)?obj:obj.records;
      if(!Array.isArray(incoming)) throw 0;
      const ok=await confirmModal('استعادة نسخة',
        `الملف يحتوي ${incoming.length} تسجيل. سيُدمج مع بياناتك الحالية (مع تجاهل المكرر). متابعة؟`,'دمج');
      if(!ok){ e.target.value=''; return; }
      const seen=new Set(records.map(r=>r.date+'|'+r.hosp+'|'+r.period+'|'+r.dept));
      let added=0;
      incoming.forEach((r,k)=>{ const key=r.date+'|'+r.hosp+'|'+r.period+'|'+r.dept;
        if(!seen.has(key)){ seen.add(key);
          const rec={...r, id:r.id||Date.now()+k};
          if(!rec.status) rec.status = rec.signature ? 'approved' : 'pending';
          records.push(rec); added++; } });
      save(); renderAll(); toast(`✓ تمت استعادة ${added} تسجيل`);
    }catch(err){ toast('ملف نسخة غير صالح',true); }
    e.target.value='';
  };
  rd.readAsText(file);
};

/* ======================= PDF REPORT (print-based, offline, with signatures) ======================= */
$('expPdf').onclick=()=>{
  if(!records.length){ toast('لا توجد بيانات للتقرير',true); return; }
  const rows=records.slice().sort((a,b)=>a.date.localeCompare(b.date));
  const sched=sum(rows,r=>r.sched), present=sum(rows,r=>r.present);
  const comp=sched?present/sched:0;
  const today=new Date().toLocaleDateString('ar-SA-u-ca-gregory',{day:'numeric',month:'long',year:'numeric'});
  const body=rows.map(r=>{ const c=r.sched?r.present/r.sched:0;
    return `<tr>
      <td>${fmtDate(r.date)}</td><td>${r.hosp}</td><td>${r.dept}</td><td>${r.period}</td>
      <td>${r.sched}</td><td>${r.present}</td><td>${r.absent}</td>
      <td style="color:${c>=.95?'#2E7D32':c>=.9?'#E65100':'#C62828'};font-weight:700">${(c*100).toFixed(1)}%</td>
      <td>${r.deputy||'—'}</td>
      <td>${r.signature?`<img src="${r.signature}" style="height:34px"/>`:'—'}</td>
    </tr>`; }).join('');
  const win=window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8">
  <title>تقرير الانتظام</title><style>
  *{font-family:'Segoe UI','Tahoma',sans-serif}
  body{margin:24px;color:#1a1a1a}
  .head{text-align:center;border-bottom:3px solid #0B3954;padding-bottom:12px;margin-bottom:16px}
  .head h1{margin:0;color:#0B3954;font-size:20px}
  .head p{margin:4px 0 0;color:#5b6b73;font-size:13px}
  .summary{display:flex;gap:12px;justify-content:center;margin:14px 0 18px}
  .summary div{background:#F4F9FA;border:1px solid #e2e9ec;border-radius:10px;padding:10px 18px;text-align:center}
  .summary b{display:block;font-size:18px;color:#0E7C7B}
  .summary span{font-size:11px;color:#5b6b73}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:#0B3954;color:#fff;padding:7px 5px}
  td{border:1px solid #e2e9ec;padding:5px;text-align:center}
  tr:nth-child(even) td{background:#f8fbfc}
  .foot{margin-top:20px;font-size:11px;color:#5b6b73;text-align:center}
  @media print{.noprint{display:none}}
  </style></head><body>

  <div class="head"><h1>تقرير انتظام العاملين</h1>
    <p>المستشفيات الثلاث — مدينة المنورة • صادر بتاريخ ${today}</p></div>
  <div class="summary">
    <div><b>${rows.length}</b><span>عدد التسجيلات</span></div>
    <div><b>${pct(comp)}</b><span>نسبة الالتزام العامة</span></div>
    <div><b>${present}/${sched}</b><span>الحضور / المجدولون</span></div>
  </div>
  <table><thead><tr><th>التاريخ</th><th>المستشفى</th><th>القسم</th><th>الفترة</th>
    <th>مجدول</th><th>حاضر</th><th>غياب</th><th>الالتزام</th><th>النائب الإداري</th><th>التوقيع</th>
  </tr></thead><tbody>${body}</tbody></table>
  <div class="foot">هذا التقرير مُولّد آلياً من تطبيق التسجيل اليومي للانتظام</div>
  <div class="noprint" style="text-align:center;margin-top:18px">
    <button onclick="window.print()" style="background:#0B3954;color:#fff;border:none;padding:10px 26px;border-radius:8px;font-size:14px;cursor:pointer">🖨️ طباعة / حفظ PDF</button>
  </div></body></html>`);
  win.document.close();
  setTimeout(()=>{ try{win.focus();}catch(e){} },300);
  toast('✓ افتح نافذة الطباعة واختر «حفظ كـ PDF»');
};

/* ======================= CLEAR + STORE NOTE ======================= */
$('clearBtn').onclick=async ()=>{
  const ok=await confirmModal('حذف جميع البيانات','سيتم حذف كل التسجيلات نهائياً ولا يمكن التراجع. متأكد؟','حذف الكل');
  if(ok){ records=[]; save(); renderAll(); toast('تم حذف جميع البيانات'); }
};
function updateStoreNote(){ $('storeNote').innerHTML=
  `محفوظ على هذا الجهاز: <b>${records.length}</b> تسجيل<br>⚠️ احرص على حفظ نسخة احتياطية دورياً لتفادي فقدان البيانات`; }

/* ======================= DARK MODE ======================= */
function applyTheme(t){ document.body.classList.toggle('dark',t==='dark');
  $('themeBtn').textContent = t==='dark'?'☀️':'🌙';
  // re-render chart so SVG colors update
  if(document.querySelector('.nav button.active').dataset.view==='dash') renderDash(); }
$('themeBtn').onclick=()=>{ const next=document.body.classList.contains('dark')?'light':'dark';
  localStorage.setItem(THEME_KEY,next); applyTheme(next); };
applyTheme(localStorage.getItem(THEME_KEY)||'light');

/* ======================= HOWTO / HELP ======================= */
const HOWTO_KEY='attendance_howto_dismissed_v1';
function showHowto(force){
  const c=$('howtoCard');
  if(force || localStorage.getItem(HOWTO_KEY)!=='1') c.classList.remove('hide');
  else c.classList.add('hide');
}
$('howtoClose').onclick=()=>{ $('howtoCard').classList.add('hide');
  localStorage.setItem(HOWTO_KEY,'1'); };
$('helpBtn').onclick=()=>{ switchView('entry'); showHowto(true);
  $('howtoCard').scrollIntoView({behavior:'smooth',block:'start'}); };
showHowto(false);

/* ======================= PIN LOCK ======================= */
let pinBuffer='', pinMode='enter', pinFirst='';
function buildPinPad(){ const pad=$('pinPad'); pad.innerHTML='';
  const keys=['1','2','3','4','5','6','7','8','9','blank','0','del'];
  keys.forEach(k=>{ const b=document.createElement('button');
    if(k==='blank'){ b.className='blank'; b.disabled=true; }
    else if(k==='del'){ b.textContent='⌫'; b.onclick=()=>{ pinBuffer=pinBuffer.slice(0,-1); paintDots(); }; }
    else{ b.textContent=k; b.onclick=()=>pinPush(k); }
    pad.appendChild(b); });
}
function paintDots(){ document.querySelectorAll('#pinDots span').forEach((s,i)=>
  s.classList.toggle('fill',i<pinBuffer.length)); }
function pinPush(d){ if(pinBuffer.length>=4) return; pinBuffer+=d; paintDots();
  if(pinBuffer.length===4) setTimeout(handlePin,150); }
function handlePin(){
  const stored=localStorage.getItem(PIN_KEY);
  if(pinMode==='set'){
    if(!pinFirst){ pinFirst=pinBuffer; pinBuffer=''; paintDots();
      $('lockTitle').textContent='أعد إدخال الرمز'; $('lockSub').textContent='للتأكيد'; return; }
    if(pinFirst===pinBuffer){ localStorage.setItem(PIN_KEY,pinBuffer);
      closeLock(); toast('✓ تم تفعيل القفل'); refreshPinBtn(); }
    else{ $('lockErr').textContent='غير متطابق، أعد المحاولة'; pinFirst=''; pinBuffer=''; paintDots();
      $('lockTitle').textContent='أنشئ رمزاً جديداً'; $('lockSub').textContent='4 أرقام'; }
  }else{ // enter
    if(pinBuffer===stored){ $('lockErr').textContent=''; closeLock(); }
    else{ $('lockErr').textContent='رمز غير صحيح'; pinBuffer=''; paintDots();
      navigator.vibrate&&navigator.vibrate(120); }
  }
}
function openLock(mode){ pinMode=mode; pinBuffer=''; pinFirst=''; $('lockErr').textContent='';
  paintDots(); $('lockScreen').classList.add('on');
  if(mode==='set'){ $('lockTitle').textContent='أنشئ رمزاً جديداً'; $('lockSub').textContent='4 أرقام';
    $('lockReset').style.display='none'; }
  else{ $('lockTitle').textContent='أدخل الرمز'; $('lockSub').textContent='رمز الدخول المكوّن من 4 أرقام';
    $('lockReset').style.display='block'; }
}
function closeLock(){ $('lockScreen').classList.remove('on'); }
$('lockReset').onclick=async ()=>{
  closeLock();
  const ok=await confirmModal('نسيت الرمز','لإزالة القفل يجب حذف جميع البيانات. متابعة؟','حذف الكل وإزالة القفل');
  if(ok){ localStorage.removeItem(PIN_KEY); records=[]; save(); renderAll(); refreshPinBtn(); toast('تمت إزالة القفل والبيانات'); }
  else openLock('enter');
};
function refreshPinBtn(){ const on=!!localStorage.getItem(PIN_KEY);
  $('pinToggle').textContent = on?'🔓 إلغاء القفل برمز':'🔒 تفعيل القفل برمز'; }
$('pinToggle').onclick=async ()=>{
  if(localStorage.getItem(PIN_KEY)){
    const ok=await confirmModal('إلغاء القفل','سيتم إلغاء حماية الرمز. متابعة؟','إلغاء القفل');
    if(ok){ localStorage.removeItem(PIN_KEY); refreshPinBtn(); toast('تم إلغاء القفل'); }
  }else{ openLock('set'); }
};
buildPinPad(); refreshPinBtn();

/* ======================= RENDER ALL ======================= */
function renderAll(){
  refreshNavBadge();
  if(typeof refreshAllBadges==='function') refreshAllBadges();
  const activeBtn=document.querySelector('.nav button.active');
  const active=activeBtn? activeBtn.dataset.view : null;
  if(active==='dash') renderDash();
  if(active==='records') renderRecords();
  if(active==='approve') renderApproval();
  if(active==='export') updateStoreNote();
  if(active==='mytasks') renderMyTasks();
  if(active==='supervise') renderSupervise();
  if(active==='manage'){ renderUsers(); renderAllTasks(); }
}

/* migrate older records: any record with a signature is treated as already approved,
   anything else becomes pending so it shows up for end-of-period signing */
function migrateStatus(){
  let changed=false;
  records.forEach(r=>{ if(!r.status){
    r.status = r.signature ? 'approved' : 'pending'; changed=true; } });
  if(changed) save();
}

/* =======================================================================
   ============  نظام الصلاحيات + متابعة الموظفين + المهام  ============
   ======================================================================= */
const USERS_KEY='attendance_users_v1';
const SESSION_KEY='attendance_session_v1';
const TASKS_KEY='attendance_tasks_v1';

let users=[], tasks=[], session=null;

function loadUsers(){ try{ users=JSON.parse(localStorage.getItem(USERS_KEY)||'[]'); }catch(e){ users=[]; } }
function saveUsers(){ localStorage.setItem(USERS_KEY, JSON.stringify(users)); }
function loadTasks(){ try{ tasks=JSON.parse(localStorage.getItem(TASKS_KEY)||'[]'); }catch(e){ tasks=[]; } }
function saveTasks(){ localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); }
function loadSession(){ try{ session=JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ session=null; } }
function saveSession(){ session? localStorage.setItem(SESSION_KEY,JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY); }

function currentUser(){ return session? users.find(u=>u.id===session.userId) : null; }
function isAdmin(){ const u=currentUser(); return u && u.role==='admin'; }
function initials(name){ const p=(name||'').trim().split(/\s+/); return ((p[0]||'')[0]||'')+((p[1]||'')[0]||''); }

/* seed a default admin on first run */
function seedUsers(){
  if(users.length) return;
  users=[{ id:'u'+Date.now(), name:'مسؤول الموظفين', role:'admin',
    hosp:HOSPITALS[0], dept:'الجودة وسلامة المرضى', pin:'1234', active:true, createdAt:new Date().toISOString() }];
  saveUsers();
}

/* ---------- task status helpers ---------- */
function effectiveTaskStatus(t){
  if(t.status==='done') return 'done';
  if(t.due){ const today=new Date().toISOString().slice(0,10);
    if(t.due<today) return 'overdue'; }
  return t.status; // open | in_progress
}
const TASK_LABEL={open:'جديدة',in_progress:'قيد التنفيذ',done:'منجزة',overdue:'متأخرة'};
const PRIO_LABEL={normal:'عادية',medium:'متوسطة',high:'عالية'};

/* ======================= LOGIN ======================= */
let loginPick=null;
let gateRole=null; // 'staff' | 'admin' | null
function renderLoginUsers(){
  const c=$('loginUsers');
  let act=users.filter(u=>u.active!==false);
  if(gateRole) act=act.filter(u=>u.role===gateRole);
  if(act.length===0){
    c.innerHTML=`<p style="text-align:center;color:var(--muted);font-size:12.5px;padding:18px 6px;line-height:1.7">
      لا توجد حسابات ${gateRole==='admin'?'مدراء':'عاملين'} بعد.${gateRole==='admin'?'<br>استخدم الحساب الافتراضي للمدير (الرمز 1234) إن وُجد.':'<br>يضيف المدير حسابك من تبويب «الإدارة».'}</p>`;
    return;
  }
  c.innerHTML=act.map(u=>`<button class="usr-pick" data-id="${u.id}">
    <span class="usr-av ${u.role}">${initials(u.name)||'؟'}</span>
    <span class="usr-info"><span class="nm">${u.name}</span>
      <span class="rl">${u.role==='admin'?'مسؤول متابعة':(u.dept||'موظف')}</span></span>
    <span class="role-tag ${u.role}">${u.role==='admin'?'مسؤول':'موظف'}</span>
  </button>`).join('');
  c.querySelectorAll('.usr-pick').forEach(b=>b.onclick=()=>pickLoginUser(b.dataset.id));
}
function pickLoginUser(id){
  loginPick=users.find(u=>u.id===id); if(!loginPick) return;
  $('loginSelected').innerHTML=`<span class="usr-av ${loginPick.role}">${initials(loginPick.name)}</span>
    <span class="usr-info"><span class="nm">${loginPick.name}</span>
    <span class="rl">${loginPick.role==='admin'?'مسؤول متابعة':(loginPick.dept||'موظف')}</span></span>`;
  $('loginStep1').style.display='none'; $('loginStep2').style.display='block';
  $('loginErr').textContent='';
  const ins=$('loginScreen').querySelectorAll('.login-pin input');
  ins.forEach(i=>i.value=''); setTimeout(()=>ins[0].focus(),60);
}
function setupLoginPin(){
  const ins=[...$('loginScreen').querySelectorAll('.login-pin input')];
  ins.forEach((inp,i)=>{
    inp.addEventListener('input',()=>{
      inp.value=inp.value.replace(/\D/g,'');
      if(inp.value && i<3) ins[i+1].focus();
      if(ins.every(x=>x.value)) tryLogin(ins.map(x=>x.value).join(''));
    });
    inp.addEventListener('keydown',e=>{ if(e.key==='Backspace' && !inp.value && i>0) ins[i-1].focus(); });
  });
}
function tryLogin(pin){
  if(!loginPick) return;
  if(pin===loginPick.pin){
    session={userId:loginPick.id, role:loginPick.role, name:loginPick.name};
    saveSession();
    $('loginScreen').classList.remove('on');
    applyRole();
    const ins=$('loginScreen').querySelectorAll('.login-pin input'); ins.forEach(i=>i.value='');
    toast('مرحباً '+loginPick.name);
  } else {
    $('loginErr').textContent='رمز الدخول غير صحيح';
    const ins=$('loginScreen').querySelectorAll('.login-pin input');
    ins.forEach(i=>i.value=''); ins[0].focus();
  }
}
function openLogin(){
  loginPick=null;
  $('loginStep1').style.display='block'; $('loginStep2').style.display='none';
  $('loginErr').textContent='';
  $('loginTitle').textContent = gateRole==='admin' ? 'دخول المدراء' : 'دخول العاملين';
  $('loginSub').textContent = gateRole==='admin'
    ? 'اختر حساب المدير ثم أدخل رمز الدخول'
    : 'اختر حسابك ثم أدخل رمز الدخول';
  $('loginListLabel').textContent = gateRole==='admin' ? 'حسابات المدراء' : 'حسابات العاملين';
  renderLoginUsers();
  $('gateScreen').classList.remove('on');
  $('loginScreen').classList.add('on');
}
function openGate(){
  $('loginScreen').classList.remove('on');
  $('gateScreen').classList.add('on');
}
function logout(){ session=null; saveSession(); gateRole=null; openGate(); }

/* ======================= APPLY ROLE (show/hide tabs) ======================= */
function applyRole(){
  const u=currentUser();
  const chip=$('userChip');
  if(u){
    chip.style.display='inline-flex';
    $('ucAv').textContent=initials(u.name)||'؟';
    $('ucName').textContent=u.name;
  } else chip.style.display='none';

  const role=u? u.role : null;
  document.querySelectorAll('.nav button').forEach(b=>{
    const roles=(b.dataset.roles||'').split(',');
    b.style.display = role && roles.includes(role) ? 'flex' : 'none';
  });
  // pick a valid default view for this role
  const firstVisible=[...document.querySelectorAll('.nav button')].find(b=>b.style.display!=='none');
  let active=document.querySelector('.nav button.active');
  if(!active || active.style.display==='none'){
    if(firstVisible) switchView(firstVisible.dataset.view);
  } else {
    switchView(active.dataset.view);
  }
  refreshAllBadges();
}

/* ======================= RECORD REVIEW (admin verifies entries) ======================= */
function ensureReview(r){ if(!r.review) r.review={state:'none',by:'',note:'',at:''}; return r.review; }

function reviewQueueData(){
  // entries not yet reviewed (or rejected), newest first
  return records.filter(r=>{ const rv=r.review||{}; return rv.state!=='approved'; })
    .sort((a,b)=> b.date.localeCompare(a.date)||b.id-a.id);
}
function renderReviewQueue(){
  const box=$('reviewQueue'); const data=reviewQueueData();
  if(!data.length){ box.innerHTML='<div class="empty-sm"><div class="e-ic">✅</div><h3>لا توجد تسجيلات معلّقة</h3><p>كل التسجيلات روجعت</p></div>'; return; }
  box.innerHTML=data.map(r=>{
    const c=r.sched?r.present/r.sched:0; const rv=r.review||{state:'none'};
    const rejected=rv.state==='rejected';
    return `<div class="rec" style="margin-bottom:11px">
      <div class="r-top"><span class="r-hosp">${r.hosp}</span><span class="r-date">${fmtDate(r.date)}</span></div>
      <div class="r-meta">${r.dept} • ${r.period} • أدخلها: ${r.by}</div>
      <div class="r-stats">
        <span class="tag c">حضور ${r.present}/${r.sched}</span>
        <span class="tag">التزام ${r.sched?pct(c):'—'}</span>
        ${r.absent?`<span class="tag a">غياب ${r.absent}</span>`:''}
        ${r.withdraw?`<span class="tag">انسحاب ${r.withdraw}</span>`:''}
        ${r.perm?`<span class="tag">استئذان ${r.perm}</span>`:''}
      </div>
      ${rejected?`<div class="review-note rejected">↩️ أُرجع للتصحيح: ${rv.note||''}</div>`:''}
      <div class="rev-btns">
        <button class="btn btn-sm btn-app" data-app="${r.id}">✓ اعتماد المراجعة</button>
        <button class="btn btn-sm btn-rej" data-rej="${r.id}">↩️ إرجاع مع ملاحظة</button>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-app]').forEach(b=>b.onclick=()=>approveReview(b.dataset.app));
  box.querySelectorAll('[data-rej]').forEach(b=>b.onclick=()=>rejectReview(b.dataset.rej));
}
function approveReview(id){
  const r=records.find(x=>x.id==id); if(!r) return;
  ensureReview(r); r.review={state:'approved',by:session.name,note:'',at:new Date().toISOString()};
  save(); toast('✓ اعتُمدت مراجعة التسجيل'); renderSupervise(); renderAll();
}
function rejectReview(id){
  const r=records.find(x=>x.id==id); if(!r) return;
  openNote('إرجاع التسجيل للتصحيح',
    `${r.dept} • ${r.period} • ${fmtDate(r.date)}`,
    'سبب الإرجاع / المطلوب تصحيحه', (note)=>{
      if(!note){ toast('اكتب سبب الإرجاع',true); return false; }
      ensureReview(r); r.review={state:'rejected',by:session.name,note,at:new Date().toISOString()};
      save(); toast('↩️ أُرجع التسجيل للموظف'); renderSupervise(); renderAll(); return true;
    });
}

/* ======================= STAFF MONITOR (admin) ======================= */
function staffStats(u){
  const recs=records.filter(r=>r.by===u.name);
  const s=sum(recs,r=>r.sched), p=sum(recs,r=>r.present);
  const comp=s?p/s:0;
  const myTasks=tasks.filter(t=>t.assignee===u.id);
  const done=myTasks.filter(t=>t.status==='done').length;
  const late=myTasks.filter(t=>effectiveTaskStatus(t)==='overdue').length;
  const openn=myTasks.filter(t=>effectiveTaskStatus(t)==='open'||effectiveTaskStatus(t)==='in_progress').length;
  return {recs:recs.length, comp, hasRec:s>0, tasks:myTasks.length, done, late, openn};
}
function renderStaffMonitor(){
  const box=$('staffMonitor'); const staff=users.filter(u=>u.role==='staff'&&u.active!==false);
  if(!staff.length){ box.innerHTML='<div class="empty-sm"><div class="e-ic">👥</div><h3>لا يوجد موظفون</h3><p>أضف موظفين من تبويب «الإدارة»</p></div>'; return; }
  box.innerHTML=staff.map(u=>{
    const st=staffStats(u);
    return `<div class="staff-row">
      <span class="usr-av staff">${initials(u.name)||'؟'}</span>
      <div class="sr-main">
        <div class="nm">${u.name}</div>
        <div class="meta">${u.dept||'—'} • ${st.recs} تسجيل • التزام ${st.hasRec?pct(st.comp):'—'}</div>
        <div class="sr-stats">
          <span class="st done">منجز ${st.done}</span>
          <span class="st open">جارٍ ${st.openn}</span>
          ${st.late?`<span class="st late">متأخر ${st.late}</span>`:''}
        </div>
      </div>
    </div>`;
  }).join('');
}
function renderSupSummary(){
  const box=$('supSummary');
  const pendRev=reviewQueueData().length;
  const staffN=users.filter(u=>u.role==='staff'&&u.active!==false).length;
  const openTasks=tasks.filter(t=>{const s=effectiveTaskStatus(t);return s==='open'||s==='in_progress';}).length;
  const lateTasks=tasks.filter(t=>effectiveTaskStatus(t)==='overdue').length;
  const item=(lbl,val,color)=>`<div class="kpi-item"><div class="ki-lbl">${lbl}</div><div class="ki-val" style="color:${color}">${val}</div></div>`;
  box.innerHTML=
    item('بانتظار مراجعتك',pendRev, pendRev?'var(--warn)':'var(--good)')+
    item('عدد الموظفين',staffN,'var(--teal)')+
    item('مهام جارية',openTasks,'var(--navy)')+
    item('مهام متأخرة',lateTasks, lateTasks?'var(--bad)':'var(--good)');
}
function renderSupervise(){
  renderSupSummary(); renderReviewQueue(); renderStaffMonitor();
}

/* ======================= TASKS ======================= */
let myTaskFilter='all', allTaskFilter='all';

function taskCard(t, forAdmin){
  const st=effectiveTaskStatus(t);
  const assignee=users.find(u=>u.id===t.assignee);
  const today=new Date().toISOString().slice(0,10);
  const dueLate = t.due && t.due<today && t.status!=='done';
  const acts = forAdmin ? `
      <button class="btn btn-ghost btn-sm" data-tdel="${t.id}">🗑️ حذف</button>`
    : (t.status!=='done' ? `
      ${t.status==='open'?`<button class="btn btn-ghost btn-sm" data-tstart="${t.id}">▶ بدء التنفيذ</button>`:''}
      <button class="btn btn-primary btn-sm" data-tdone="${t.id}">✓ تم الإنجاز</button>` : '');
  return `<div class="task ${st}">
    <div class="task-top">
      <p class="task-title">${t.title}</p>
      <span class="task-st ${st}">${TASK_LABEL[st]}</span>
    </div>
    ${t.desc?`<p class="task-desc">${t.desc}</p>`:''}
    <div class="task-meta">
      ${forAdmin?`<span class="tm">👤 ${assignee?assignee.name:'—'}</span>`:''}
      ${t.priority&&t.priority!=='normal'?`<span class="tm pri-${t.priority==='high'?'high':'med'}">أولوية ${PRIO_LABEL[t.priority]}</span>`:''}
      ${t.due?`<span class="tm ${dueLate?'due-late':''}">📅 ${fmtDate(t.due)}</span>`:''}
      <span class="tm">أسندها: ${t.assignedBy||'—'}</span>
    </div>
    ${t.proof?`<div class="task-proof">📎 إثبات الإنجاز: ${t.proof}</div>`:''}
    ${(acts.trim())?`<div class="task-acts">${acts}</div>`:''}
  </div>`;
}
function renderMyTasks(){
  const u=currentUser(); if(!u) return;
  let data=tasks.filter(t=>t.assignee===u.id);
  if(myTaskFilter!=='all') data=data.filter(t=>{
    const s=effectiveTaskStatus(t);
    return myTaskFilter==='done'? s==='done'
      : myTaskFilter==='open'? (s==='open'||s==='overdue')
      : myTaskFilter==='in_progress'? s==='in_progress' : true;
  });
  data.sort((a,b)=> (a.status==='done')-(b.status==='done') || (a.due||'').localeCompare(b.due||''));
  $('myTaskCount').textContent=data.length?`${data.length} مهمة`:'';
  const box=$('myTasksList');
  if(!data.length){ box.innerHTML='<div class="empty-sm"><div class="e-ic">📋</div><h3>لا توجد مهام</h3><p>لا مهام مطابقة لهذا الفلتر</p></div>'; return; }
  box.innerHTML=data.map(t=>taskCard(t,false)).join('');
  box.querySelectorAll('[data-tstart]').forEach(b=>b.onclick=()=>{
    const t=tasks.find(x=>x.id==b.dataset.tstart); if(t){ t.status='in_progress'; saveTasks(); renderMyTasks(); refreshAllBadges(); toast('بدأت تنفيذ المهمة'); }
  });
  box.querySelectorAll('[data-tdone]').forEach(b=>b.onclick=()=>{
    const t=tasks.find(x=>x.id==b.dataset.tdone); if(!t) return;
    openNote('تأكيد إنجاز المهمة', t.title, 'إثبات/وصف ما تم إنجازه (اختياري)', (note)=>{
      t.status='done'; t.doneAt=new Date().toISOString(); t.proof=note||'';
      saveTasks(); renderMyTasks(); refreshAllBadges(); toast('✓ سُجّل إنجاز المهمة'); return true;
    });
  });
}
function renderAllTasks(){
  let data=tasks.slice();
  if(allTaskFilter!=='all') data=data.filter(t=>effectiveTaskStatus(t)===allTaskFilter);
  data.sort((a,b)=> (a.status==='done')-(b.status==='done') || (a.due||'').localeCompare(b.due||''));
  const box=$('allTasksList');
  if(!data.length){ box.innerHTML='<div class="empty-sm"><div class="e-ic">📋</div><h3>لا توجد مهام</h3><p>أسند مهمة جديدة من الأعلى</p></div>'; return; }
  box.innerHTML=data.map(t=>taskCard(t,true)).join('');
  box.querySelectorAll('[data-tdel]').forEach(b=>b.onclick=async ()=>{
    const ok=await confirmModal('حذف المهمة','سيُحذف هذا التكليف نهائياً. متابعة؟','حذف');
    if(ok){ tasks=tasks.filter(x=>x.id!=b.dataset.tdel); saveTasks(); renderAllTasks(); refreshAllBadges(); toast('تم حذف المهمة'); }
  });
}

/* ======================= MANAGE USERS ======================= */
let editingUserId=null;
function renderUsers(){
  const box=$('usersList');
  box.innerHTML=users.map(u=>`<div class="mng-user ${u.active===false?'inactive':''}">
    <span class="usr-av ${u.role}">${initials(u.name)||'؟'}</span>
    <div class="sr-main"><div class="nm">${u.name}</div>
      <div class="meta">${u.role==='admin'?'مسؤول متابعة':(u.dept||'موظف')} • رمز: ••••${u.active===false?' • معطّل':''}</div></div>
    <div class="acts">
      <button class="icon-btn" data-uedit="${u.id}" title="تعديل">✏️</button>
      <button class="icon-btn" data-utoggle="${u.id}" title="${u.active===false?'تفعيل':'تعطيل'}">${u.active===false?'✓':'⏸'}</button>
      <button class="icon-btn danger" data-udel="${u.id}" title="حذف">🗑️</button>
    </div>
  </div>`).join('');
  box.querySelectorAll('[data-uedit]').forEach(b=>b.onclick=()=>openUserModal(b.dataset.uedit));
  box.querySelectorAll('[data-utoggle]').forEach(b=>b.onclick=()=>{
    const u=users.find(x=>x.id==b.dataset.utoggle); if(u){ u.active=u.active===false; saveUsers(); renderUsers(); toast(u.active===false?'عُطّل الحساب':'فُعّل الحساب'); }
  });
  box.querySelectorAll('[data-udel]').forEach(b=>b.onclick=async ()=>{
    const u=users.find(x=>x.id==b.dataset.udel);
    if(u && u.id===session.userId){ toast('لا يمكن حذف حسابك الحالي',true); return; }
    const admins=users.filter(x=>x.role==='admin'&&x.active!==false);
    if(u.role==='admin'&&admins.length<=1){ toast('يجب بقاء مسؤول واحد على الأقل',true); return; }
    const ok=await confirmModal('حذف المستخدم',`سيُحذف حساب «${u.name}». متابعة؟`,'حذف');
    if(ok){ users=users.filter(x=>x.id!=b.dataset.udel); saveUsers(); renderUsers(); toast('تم حذف المستخدم'); }
  });
}
function fillUserSelects(){
  fillSelect('u-hosp',HOSPITALS); fillSelect('u-dept',DEPARTMENTS);
}
function openUserModal(id){
  editingUserId=id||null;
  fillUserSelects();
  if(id){ const u=users.find(x=>x.id==id);
    $('userModalTitle').textContent='تعديل مستخدم';
    $('u-name').value=u.name; $('u-role').value=u.role; $('u-hosp').value=u.hosp||HOSPITALS[0];
    $('u-dept').value=u.dept||DEPARTMENTS[0]; $('u-pin').value=u.pin;
  } else {
    $('userModalTitle').textContent='إضافة مستخدم';
    $('u-name').value=''; $('u-role').value='staff'; $('u-hosp').value=HOSPITALS[0];
    $('u-dept').value=DEPARTMENTS[0]; $('u-pin').value='';
  }
  $('userBg').classList.add('on');
}
function saveUser(){
  const name=$('u-name').value.trim(), role=$('u-role').value,
    hosp=$('u-hosp').value, dept=$('u-dept').value, pin=$('u-pin').value.trim();
  if(!name){ toast('أدخل الاسم',true); return; }
  if(!/^\d{4}$/.test(pin)){ toast('الرمز يجب أن يكون 4 أرقام',true); return; }
  if(editingUserId){
    const u=users.find(x=>x.id==editingUserId);
    Object.assign(u,{name,role,hosp,dept,pin});
    if(u.id===session.userId){ session.name=name; session.role=role; saveSession(); applyRole(); }
    toast('✓ حُدّث المستخدم');
  } else {
    users.push({ id:'u'+Date.now(), name, role, hosp, dept, pin, active:true, createdAt:new Date().toISOString() });
    toast('✓ أُضيف المستخدم');
  }
  saveUsers(); $('userBg').classList.remove('on'); renderUsers();
}

/* ======================= ASSIGN TASK ======================= */
function openTaskModal(){
  const staff=users.filter(u=>u.role==='staff'&&u.active!==false);
  if(!staff.length){ toast('أضف موظفاً أولاً لإسناد المهمة',true); return; }
  $('t-assignee').innerHTML=staff.map(u=>`<option value="${u.id}">${u.name} — ${u.dept||''}</option>`).join('');
  $('t-title').value=''; $('t-desc').value=''; $('t-priority').value='normal'; $('t-due').value='';
  $('taskBg').classList.add('on');
}
function saveTask(){
  const title=$('t-title').value.trim(), assignee=$('t-assignee').value,
    priority=$('t-priority').value, due=$('t-due').value, desc=$('t-desc').value.trim();
  if(!title){ toast('أدخل عنوان المهمة',true); return; }
  if(!assignee){ toast('اختر الموظف',true); return; }
  tasks.push({ id:'t'+Date.now(), title, desc, assignee, assignedBy:session.name,
    priority, due, status:'open', createdAt:new Date().toISOString(), doneAt:'', proof:'' });
  saveTasks(); $('taskBg').classList.remove('on'); renderAllTasks(); refreshAllBadges();
  toast('✓ أُسندت المهمة');
}

/* ======================= NOTE MODAL (shared) ======================= */
let noteCb=null;
function openNote(title,sub,label,cb){
  $('noteTitle').textContent=title; $('noteSub').textContent=sub||'';
  $('noteLabel').textContent=label||'الملاحظة'; $('noteText').value='';
  noteCb=cb; $('noteBg').classList.add('on'); setTimeout(()=>$('noteText').focus(),80);
}
$('noteOk').onclick=()=>{ if(!noteCb) return; const v=$('noteText').value.trim();
  const close=noteCb(v); if(close!==false){ $('noteBg').classList.remove('on'); noteCb=null; } };
$('noteCancel').onclick=()=>{ $('noteBg').classList.remove('on'); noteCb=null; };
$('noteBg').onclick=e=>{ if(e.target===$('noteBg')){ $('noteBg').classList.remove('on'); noteCb=null; } };

/* ======================= BADGES ======================= */
function refreshAllBadges(){
  refreshNavBadge();
  // my tasks badge
  const u=currentUser();
  if(u){ const mt=tasks.filter(t=>t.assignee===u.id && t.status!=='done').length;
    const el=$('myTaskBadge'); if(el){ if(mt>0){el.textContent=mt;el.classList.add('on');}else el.classList.remove('on'); } }
  // supervise badge = pending reviews
  const sb=$('supBadge'); if(sb){ const n=reviewQueueData().length;
    if(n>0){sb.textContent=n;sb.classList.add('on');}else sb.classList.remove('on'); }
}

/* ======================= WIRE UP ======================= */
$('logoutBtn').onclick=logout;
$('gateStaff').onclick=()=>{ gateRole='staff'; openLogin(); };
$('gateAdmin').onclick=()=>{ gateRole='admin'; openLogin(); };
$('loginToGate').onclick=()=>{ gateRole=null; openGate(); };
$('loginBack').onclick=()=>{ $('loginStep1').style.display='block'; $('loginStep2').style.display='none'; loginPick=null; };
$('addUserBtn').onclick=()=>openUserModal(null);
$('userCancel').onclick=()=>$('userBg').classList.remove('on');
$('userSave').onclick=saveUser;
$('userBg').onclick=e=>{ if(e.target===$('userBg')) $('userBg').classList.remove('on'); };
$('addTaskBtn').onclick=openTaskModal;
$('taskCancel').onclick=()=>$('taskBg').classList.remove('on');
$('taskSave').onclick=saveTask;
$('taskBg').onclick=e=>{ if(e.target===$('taskBg')) $('taskBg').classList.remove('on'); };

document.querySelectorAll('#myTaskFilter button').forEach(b=>b.onclick=()=>{
  myTaskFilter=b.dataset.f;
  document.querySelectorAll('#myTaskFilter button').forEach(x=>x.classList.toggle('active',x===b));
  renderMyTasks();
});
document.querySelectorAll('#allTaskFilter button').forEach(b=>b.onclick=()=>{
  allTaskFilter=b.dataset.f;
  document.querySelectorAll('#allTaskFilter button').forEach(x=>x.classList.toggle('active',x===b));
  renderAllTasks();
});


/* ======================= INIT ======================= */
load(); migrateStatus();
loadUsers(); loadTasks(); loadSession(); seedUsers();
setupLoginPin();
livePreview(); refreshNavBadge();
// prefill last data-entry name for faster repeat entry
(function(){
  const lb=localStorage.getItem('attendance_lastby_v1');
  if(lb && !$('f-by').value) $('f-by').value=lb;
})();
// require PIN on startup if set
if(localStorage.getItem(PIN_KEY)) openLock('enter');

// auth bootstrap: if logged in, apply role; else show role gate first
if(session && currentUser()){ gateRole=currentUser().role; applyRole(); }
else { session=null; saveSession(); gateRole=null; openGate(); }

