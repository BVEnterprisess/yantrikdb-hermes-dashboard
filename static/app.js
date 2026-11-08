const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { health:null, stats:null, settings:null, defaultNamespace:'default', selectedNamespace:'__all__', namespaceTags:[], initialized:false, view:'overview', memoryOffset:0, selectedMemory:null, recentWrites:null, identityScope:null, actorIdentityFilter:'__all__' };
const VALID_VIEWS = new Set(['overview','visualiser','memories','recall','skills','conflicts','graph','identity-scope','lifecycle','ops','settings']);
const ALL_NAMESPACES = '__all__';
const CUSTOM_NAMESPACE = '__custom__';
const DEFAULT_VIZ_CAMERA = { rotation:.55, tilt:.78, zoom:1, panX:0, panY:0 };
const viz = { frame:0, nodes:[], edges:[], byId:{}, stars:[], data:null, mode:'constellation', paused:false, interaction:'rotate', drag:null, lastFrameTime:0, ...DEFAULT_VIZ_CAMERA };

function fmt(n){ if(n===undefined||n===null) return '—'; if(typeof n==='number') return n.toLocaleString(); return n; }
function esc(s){ return String(s ?? '').replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); }

function setScopeLoading(on, label='Loading…'){
  const scopeBar=$('#scopeBar');
  const scopeLoading=$('#scopeLoading');
  scopeBar?.classList.toggle('is-loading', !!on);
  scopeLoading?.classList.toggle('hidden', !on);
  if(scopeLoading){ scopeLoading.lastChild && (scopeLoading.lastChild.textContent=label); }
  [$('#scopeSelect'), $('#memoryNamespaceFilter')].filter(Boolean).forEach(el=>{ el.disabled=!!on; });
  const active=$('.view.active');
  if(active) active.setAttribute('aria-busy', on?'true':'false');
}
function setVisualiserLoading(on, label='Building visualiser'){
  const loading=$('#threeLoading');
  loading?.classList.toggle('hidden', !on);
  if(loading){
    const title=loading.querySelector('strong'); if(title) title.textContent=label;
    const detail=loading.querySelector('em'); if(detail) detail.textContent=ns()===ALL_NAMESPACES?'Preparing multiple namespace graphs…':'Preparing selected memory scope…';
  }
  $('#threeViewport')?.setAttribute('aria-busy', on?'true':'false');
  ['#threeRefresh','#threeReset','#threePanMode','#threePause','#threeFullscreen'].forEach(s=>{ const el=$(s); if(el) el.disabled=!!on; });
}
async function api(path, opts={}){
  const headers = {'Content-Type':'application/json', ...(opts.headers||{})};
  const res = await fetch(path, {...opts, headers, credentials:'same-origin'});
  const txt = await res.text();
  let data; try{ data=txt?JSON.parse(txt):{} }catch{ data={raw:txt}; }
  const message=value=>typeof value==='string'?value:JSON.stringify(value);
  if(res.status===401 && res.headers.get('X-Dashboard-Auth')==='required'){
    showLogin(); throw new Error(message(data.detail || 'Authentication required'));
  }
  if(!res.ok) throw new Error(message(data.detail ?? data.error ?? res.statusText));
  if(data && (data.ok===false || data.status==='failed')) throw new Error(message(data.reason || data.error || `${data.tool||'YantrikDB'} failed`));
  return data;
}
function ns(){ return state.selectedNamespace ?? ALL_NAMESPACES; }
function setNamespace(value){ const v=value===null||value===undefined?ALL_NAMESPACES:value; state.selectedNamespace=v; if($('#scopeSelect')) $('#scopeSelect').value=v; if($('#memoryNamespaceFilter')) $('#memoryNamespaceFilter').value=v; }
function namespaceOptions(selected){
  const values=[...new Set([state.defaultNamespace,...(state.namespaceTags||[]),selected].filter(value=>value!==null&&value!==undefined&&value!==ALL_NAMESPACES&&value!==CUSTOM_NAMESPACE))].sort((a,b)=>String(a).localeCompare(String(b)));
  return `<option value="${ALL_NAMESPACES}">All namespaces</option>`+values.map(value=>`<option value="${esc(value)}">${value===''?'(empty namespace)':esc(value)}${value===state.defaultNamespace?' (default)':''}</option>`).join('')+`<option value="${CUSTOM_NAMESPACE}">Enter a namespace…</option>`;
}
function chooseNamespace(value){
  if(value!==CUSTOM_NAMESPACE){ setNamespace(value); return; }
  const valueFromUser=window.prompt('Enter a YantrikDB memory-row namespace. This is a row tag, not a tenant/database name:');
  if(valueFromUser&&valueFromUser.trim()){ setNamespace(valueFromUser.trim()); }
  else { if($('#scopeSelect')) $('#scopeSelect').value=ns(); if($('#memoryNamespaceFilter')) $('#memoryNamespaceFilter').value=ns(); }
}
function syncMemoryFiltersFromUrl(params=new URLSearchParams(location.search)){
  if(params.has('q')) $('#memorySearch').value=params.get('q')||'';
  if(params.has('status')) $('#statusFilter').value=params.get('status')||'active';
  if(params.has('domain')) $('#domainFilter').value=params.get('domain')||'';
  if(params.has('sort')) $('#sortFilter').value=params.get('sort')||'created_at';
  if(params.has('namespace')) setNamespace(params.get('namespace'));
  updateMemoryAdvancedFilters();
}
function updateMemoryAdvancedFilters(){
  const details = $('#memoryAdvancedFilters');
  if(!details) return;
  const hasAdvanced = !!($('#domainFilter')?.value || (($('#sortFilter')?.value || 'created_at') !== 'created_at'));
  details.open = hasAdvanced;
}
function routeUrlFor(view){
  const url=new URL(location.href); url.searchParams.set('view',view); url.searchParams.delete('memory');
  ['q','status','domain','sort'].forEach(k=>url.searchParams.delete(k));
  const selectedNs=ns();
  if(selectedNs!==ALL_NAMESPACES) url.searchParams.set('namespace', selectedNs); else url.searchParams.delete('namespace');
  if(view==='memories'){
    const vals={q:$('#memorySearch')?.value||'',status:$('#statusFilter')?.value||'active',domain:$('#domainFilter')?.value||'',sort:$('#sortFilter')?.value||'created_at'};
    for(const [k,v] of Object.entries(vals)) if(v && !(['status','sort'].includes(k) && ['active','created_at'].includes(v))) url.searchParams.set(k,v);
  }
  return url;
}
function writeRoute(view,{replace=false}={}){
  const url=routeUrlFor(view); const obj={view,search:url.search};
  if(replace) history.replaceState(obj,'',url); else history.pushState(obj,'',url);
}

function setView(view, opts={}){
  view = VALID_VIEWS.has(view) ? view : 'overview';
  if(opts.query){
    if(opts.query.q!==undefined) $('#memorySearch').value=opts.query.q||'';
    if(opts.query.status!==undefined) $('#statusFilter').value=opts.query.status||'active';
    if(opts.query.domain!==undefined) $('#domainFilter').value=opts.query.domain||'';
    if(opts.query.sort!==undefined) $('#sortFilter').value=opts.query.sort||'created_at';
    updateMemoryAdvancedFilters();
  }
  if(view==='memories' && opts.fromUrl) syncMemoryFiltersFromUrl();
  if(opts.updateUrl!==false) writeRoute(view,{replace:!!opts.replace});
  state.view=view; $$('.view').forEach(v=>v.classList.remove('active')); $(`#view-${view}`).classList.add('active');
  $$('.nav-item').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.body.classList.remove('menu-open');
  $('#menuToggle')?.setAttribute('aria-expanded','false');
  const names={overview:'Memory Operations',visualiser:'Visualiser',memories:'Memory Browser',recall:'Recall',skills:'Learned Skills',conflicts:'Contradictions',graph:'Entity Graph','identity-scope':'Identity & Scope',lifecycle:'Lifecycle',ops:'Maintenance',settings:'Settings'};
  $('#pageTitle').textContent=names[view]||view;
  if(view!=='visualiser') stopVisualiser();
  if(view!=='memories') closeMemoryDetail({silent:true});
  if(view==='overview' && state.stats) requestAnimationFrame(()=>drawRecent(state.recentWrites));
  if(view==='overview' && !state.stats) loadStats();
  if(view==='visualiser') loadVisualiser();
  if(view==='memories') loadMemories(); if(view==='recall' && !$('#recallQuery').value) $('#recallQuery').value='What should this agent remember about YantrikDB dashboards?';
  if(view==='skills') loadSkillRecallStatus();
  if(view==='conflicts') loadConflicts(); if(view==='graph') loadEntities(); if(view==='identity-scope') loadIdentityScope(); if(view==='lifecycle') loadLifecycle(); if(view==='ops') loadHealthPanel(); if(view==='settings') loadSettings();
}

async function waitForAuthReady(){
  if(window.yantrikdbAuthReady){
    await window.yantrikdbAuthReady;
  }else{
    await new Promise(resolve=>window.addEventListener('yantrikdb-auth-ready',resolve,{once:true}));
  }
  if(window.yantrikdbAuthError) throw new Error(window.yantrikdbAuthError);
}

async function init(){
  await waitForAuthReady();
  $('.nav-item').forEach(b=>b.onclick=()=>setView(b.dataset.view));
  $('#brandHome')?.addEventListener('click',()=>setView('overview'));
  window.addEventListener('popstate',()=>{
    const params=new URLSearchParams(location.search);
    const view=params.get('view')||'overview';
    setView(view,{updateUrl:false,fromUrl:true});
    const rid=params.get('memory');
    if(view==='memories' && rid) selectMemory(rid,{updateUrl:false});
    else if(view==='memories') closeMemoryDetail({silent:true});
  });
  if(location.search.includes('menu=open')) document.body.classList.add('menu-open');
  $('#menuToggle')?.setAttribute('aria-expanded', String(document.body.classList.contains('menu-open')));
  $('#menuToggle')?.addEventListener('click',()=>{
    const open=!document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    $('#menuToggle')?.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ document.body.classList.remove('menu-open'); $('#menuToggle')?.setAttribute('aria-expanded','false'); closeMemoryDetail({silent:true}); } });
  $('#closeMemoryDrawer')?.addEventListener('click',()=>closeMemoryDetail());
  $('#memoryDrawer')?.addEventListener('click',(e)=>{ if(e.target.id==='memoryDrawer') closeMemoryDetail(); });
  $('#scopeSelect')?.addEventListener('change',()=>{ chooseNamespace($('#scopeSelect').value); state.memoryOffset=0; writeRoute(state.view,{replace:true}); refreshAll(); });
  $('#memoryNamespaceFilter')?.addEventListener('change',()=>{ chooseNamespace($('#memoryNamespaceFilter').value); state.memoryOffset=0; writeRoute('memories',{replace:true}); refreshAll(); });
  $('#memoryApply').onclick=()=>{state.memoryOffset=0; writeRoute('memories',{replace:true}); loadMemories();};
  $('#memoryReset')?.addEventListener('click',()=>{ $('#memorySearch').value=''; $('#statusFilter').value='active'; $('#domainFilter').value=''; $('#sortFilter').value='created_at'; updateMemoryAdvancedFilters(); state.memoryOffset=0; writeRoute('memories',{replace:true}); loadMemories(); });
  $('#runRecall').onclick=runRecall; $('#runSkillSearch')?.addEventListener('click',runSkillSearch); $('#skillSearchQuery')?.addEventListener('keydown',(e)=>{ if(e.key==='Enter') runSkillSearch(); }); $('#loadConflicts').onclick=loadConflicts;
  $('#threeRefresh')?.addEventListener('click',()=>loadVisualiser(true));
  $('#threeReset')?.addEventListener('click',()=>resetVisualiser());
  $('#threePanMode')?.addEventListener('click',()=>{ threeVis.panMode=!threeVis.panMode; updateThreeUI(); });
  $('#threePause')?.addEventListener('click',()=>{ threeVis.paused=!threeVis.paused; updateThreeUI(); });
  $('#threeFullscreen')?.addEventListener('click',()=>$('#threeViewport')?.requestFullscreen?.());
  $('#threeExitFullscreen')?.addEventListener('click',()=>document.exitFullscreen?.());
  $('#threeRunRecall')?.addEventListener('click',runVisualiserRecall);
  $('#threeRecallQuery')?.addEventListener('keydown',(e)=>{ if(e.key==='Enter') runVisualiserRecall(); });
  document.addEventListener('fullscreenchange',()=>{ if(state.view==='visualiser') requestAnimationFrame(()=>resizeThree()); });
  $$('.visualiser-tabs button[data-three-mode]').forEach(b=>b.onclick=()=>setVisualiserMode(b.dataset.threeMode));
  $('#loadEntities')?.addEventListener('click',loadEntities); $('#loadGraph')?.addEventListener('click',()=>loadGraph($('#graphEntity')?.value||$('#entitySearch')?.value));
  $('#reloadIdentityScope')?.addEventListener('click',()=>loadIdentityScope());
  $('#runThink').onclick=runThink; $('#runHygieneScan')?.addEventListener('click',runHygieneScan); $('#refreshHealth').onclick=loadHealthPanel; $('#adminModeToggle')?.addEventListener('change',()=>saveSettings());

  $('#logoutBtn')?.addEventListener('click',logout);
  $('#signOutButton')?.addEventListener('click',logout);
  window.addEventListener('resize',()=>{ if(state.view==='overview' && state.stats) requestAnimationFrame(()=>drawRecent(state.recentWrites)); });
  try{ await refreshAll(); }catch(e){ toast(e.message); return; }
  const initialView = new URLSearchParams(location.search).get('view') || 'overview';
  setView(initialView,{replace:true,fromUrl:true});
  const initialMemory = new URLSearchParams(location.search).get('memory');
  if(initialView==='memories' && initialMemory) selectMemory(initialMemory,{updateUrl:false});
}
function updateAdminBadge(){ const on=!!(state.health?.admin_enabled||state.settings?.admin_mode); $('#adminBadge').textContent=on?'Admin mode enabled':'Admin mode disabled'; $('#adminBadge').className=on?'pill warn':'pill neutral'; const ops=$('#opsAdminState'); if(ops){ops.textContent=on?'Admin mode enabled':'Admin mode disabled'; ops.className=on?'pill warn':'pill neutral';} }

function selectedNamespaceMeta(){
  const current=ns();
  if(current===ALL_NAMESPACES) return {name:'All namespaces',count:null,all:true};
  return {name:current===''?'(empty namespace)':current,count:null,all:false};
}
function updateScopeUi(){
  const meta=selectedNamespaceMeta();
  const count=meta.count===null?'':`${fmt(meta.count)} memor${Number(meta.count)===1?'y':'ies'}`;
  $('#scopeCount') && ($('#scopeCount').textContent=count);
  $('#scopeBar')?.classList.toggle('all-scope', !!meta.all);
  $('#opsScopeName') && ($('#opsScopeName').textContent=meta.name);
  $('#opsScopeCount') && ($('#opsScopeCount').textContent=count);
  $('#opsScopeName')?.closest('.maintenance-scope')?.classList.toggle('all-scope', !!meta.all);
  if($('#settingsExportLink')) $('#settingsExportLink').href=`/api/export/memories.jsonl?namespace=${encodeURIComponent(ns())}&status=active`;
}
async function refreshAll(){
  const loadingLabel = state.view==='visualiser' ? 'Building visualiser…' : 'Loading…';
  setScopeLoading(true, loadingLabel);
  if(state.view==='visualiser') setVisualiserLoading(true, 'Building visualiser');
  try{
    state.health=await api('/api/health');
    state.settings=await api('/api/settings');
    state.defaultNamespace=state.health.default_namespace || state.settings.default_namespace || 'default';
    await loadIdentityScope();
    const routeParams=new URLSearchParams(location.search);
    const requested=routeParams.get('namespace');
    const prev=routeParams.has('namespace')?requested:(state.initialized?state.selectedNamespace:state.defaultNamespace);
    state.selectedNamespace=prev;
    state.initialized=true;
    const options=namespaceOptions(prev);
    const memSel=$('#memoryNamespaceFilter'); const scopeSel=$('#scopeSelect');
    [memSel,scopeSel].filter(Boolean).forEach(select=>{
      select.innerHTML=options;
      select.value=prev;
    });
    updateScopeUi();
    updateAdminBadge();
    await loadStats();
    if(state.view==='memories') await loadMemories();
    if(state.view==='lifecycle') await loadLifecycle();
    if(state.view==='visualiser') await loadVisualiser(true);
  } finally {
    setScopeLoading(false);
    if(state.view==='visualiser') setVisualiserLoading(false);
  }
}

function compactJson(value){ return JSON.stringify(value||{}, null, 2); }
function renderIdentityScope(data){
  state.identityScope=data;
  const scope=data?.identity_scope||{};
  const rows=Array.isArray(data?.namespace_inventory)?data.namespace_inventory:[];
  const summary=[
    ['Visible server scopes', rows.length],
    ['Identities', Array.isArray(scope.identities)?scope.identities.length:null],
    ['Actors', Array.isArray(scope.actors)?scope.actors.length:null],
    ['Shared spaces', Array.isArray(scope.spaces)?scope.spaces.length:null],
    ['Conversation routes', Array.isArray(scope.conversations)?scope.conversations.length:null],
  ];
  if($('#identityScopeSummary')) $('#identityScopeSummary').innerHTML=summary.map(([label,value])=>`<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${fmt(value)}</div></div>`).join('');
  if($('#identityNamespaceTable')){
    $('#identityNamespaceTable').innerHTML=rows.length?`<table><thead><tr><th>Visible tenant / database</th><th>Row count</th><th>Identity mapping</th></tr></thead><tbody>${rows.map(row=>`<tr><td><code>${esc(row.namespace||'')}</code></td><td>${fmt(row.count)}</td><td>${row.mapped===true?esc(row.mapped_to||row.mapped_scope||'Mapped'):(row.mapped===false?'Not mapped':'Not provided')}</td></tr>`).join('')}</tbody></table>`:'<div class="empty helpful-empty"><strong>No server scope inventory was returned.</strong><span>Check the server token permissions and the YantrikDB /v1/identity-scope response.</span></div>';
  }
  if($('#identityScopeJson')) $('#identityScopeJson').value=compactJson(data);
  updateScopeUi();
}
async function loadIdentityScope(){
  try{ renderIdentityScope(await api('/api/identity-scope')); }
  catch(e){
    state.identityScope=null;
    if($('#identityScopeSummary')) $('#identityScopeSummary').innerHTML=`<div class="empty">${esc(e.message)}</div>`;
    if($('#identityNamespaceTable')) $('#identityNamespaceTable').innerHTML=`<div class="empty">${esc(e.message)}</div>`;
    if($('#identityScopeJson')) $('#identityScopeJson').value='';
  }
}

function settingsRows(settings){
  const rows=[
    ['Backend mode', settings.backend_mode],
    ['YantrikDB server', settings.server_url],
    ['Default namespace', settings.default_namespace],
    ['Supabase Auth', settings.supabase_auth_configured?'Configured':'Publishable key required'],
    ['Admin mode', settings.admin_mode?'Enabled':'Read-only'],
  ];
  return rows.map(([key,value])=>`<div class="diag-row"><span>${esc(key)}</span><strong>${esc(value ?? '—')}</strong></div>`).join('');
}
async function loadSettings(){
  state.settings=await api('/api/settings');
  const toggle=$('#adminModeToggle'); if(toggle) toggle.checked=!!state.settings.admin_mode;
  if($('#settingsServerUrl')) $('#settingsServerUrl').textContent=state.settings.server_url||'—';
  if($('#settingsNamespace')) $('#settingsNamespace').textContent=state.settings.default_namespace||'—';
  if($('#settingsAuthState')){
    $('#settingsAuthState').textContent=state.settings.supabase_auth_configured?'Supabase Auth':'Setup required';
    $('#settingsAuthState').className=state.settings.supabase_auth_configured?'pill good':'pill warn';
  }
  updateScopeUi();
  if($('#settingsRuntime')) $('#settingsRuntime').innerHTML=settingsRows(state.settings);
  updateAdminBadge();
}
async function saveSettings(){
  const enabled=!!$('#adminModeToggle')?.checked;
  try{
    state.settings=await api('/api/settings',{method:'POST',body:JSON.stringify({admin_mode:enabled})});
    await loadSettings();
    toast(enabled?'Admin Mode enabled':'Admin Mode disabled');
  }catch(e){toast(e.message); await loadSettings();}
}

function showLogin(){
  if(location.pathname !== '/login') window.location.replace('/login');
}
async function logout(){
  try{
    if(window.yantrikdbAuth?.signOut) await window.yantrikdbAuth.signOut();
    else await fetch('/api/auth/session',{method:'DELETE',credentials:'same-origin'});
    window.location.replace('/login');
  }catch(e){ toast(e.message || 'Sign out failed'); }
}

async function loadStats(){
  state.stats=await api(`/api/stats?namespace=${encodeURIComponent(ns())}`);
  const engine=state.stats.engine||{};
  const active = engine.active_memories ?? null;
  const consolidated = engine.consolidated_memories ?? null;
  const tomb = engine.tombstoned_memories ?? null;
  const metrics=[['Active',active],['Consolidated',consolidated],['Forgotten',tomb],['Open conflicts',state.stats.open_conflicts],['Entities',state.stats.entities],['Edges',state.stats.edges],['DB size',humanBytes(state.health?.db_size_bytes)],['Embedder',state.health?.embedder]];
  if($('#heroMetrics')) $('#heroMetrics').innerHTML=metrics.slice(0,4).map(m=>metric(m[0],m[1])).join('');
  if($('#statsGrid')) $('#statsGrid').innerHTML=metrics.map(m=>`<div class="stat-card"><div class="stat-label">${esc(m[0])}</div><div class="stat-value">${esc(fmt(m[1]))}</div></div>`).join('');
  if($('#composition')) $('#composition').innerHTML=compositionBlock('Domains',state.stats.by_domain)+compositionBlock('Sources',state.stats.by_source)+compositionBlock('Types',state.stats.by_type);
  state.recentWrites=state.stats.recent_by_day;
  drawRecent(state.recentWrites);
  const namespaces=Array.isArray(state.identityScope?.namespace_inventory)?state.identityScope.namespace_inventory:[];
  if($('#namespaceTable')) $('#namespaceTable').innerHTML=namespaces.length?`<table><thead><tr><th>Visible tenant / database</th><th>Row count</th><th>Identity mapping</th></tr></thead><tbody>${namespaces.map(row=>`<tr><td><code>${esc(row.namespace||'')}</code></td><td>${fmt(row.count)}</td><td>${row.mapped===true?esc(row.mapped_to||row.mapped_scope||'Mapped'):(row.mapped===false?'Not mapped':'Not provided')}</td></tr>`).join('')}</tbody></table>`:'<div class="empty helpful-empty"><strong>Server scope inventory unavailable.</strong><span>The HTTP identity-scope route does not provide row-tag counts.</span></div>'; 
  const scopeNote=$('#statsScopeNote'); if(scopeNote) scopeNote.textContent='YantrikDB /v1/stats reports database-wide totals; namespace selection applies to memory and temporal queries, not these totals.';
  updateScopeUi();
}

function humanBytes(b){ if(b===null||b===undefined) return '—'; if(!b) return '0 B'; const u=['B','KB','MB','GB']; let i=0; while(b>1024&&i<u.length-1){b/=1024;i++;} return `${b.toFixed(i?1:0)} ${u[i]}`; }
function metric(label,value){return `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(fmt(value))}</div></div>`}
function compositionBlock(title, arr){ if(!Array.isArray(arr)) return `<div class="detail-section"><div class="label">${title}</div><div class="muted">Not exposed by the YantrikDB HTTP statistics endpoint.</div></div>`; const max=Math.max(1,...arr.map(x=>x.count)); return `<div class="detail-section"><div class="label">${title}</div>${arr.slice(0,8).map(x=>`<div class="bar-row"><span>${esc(x.domain||x.source||x.type||'—')}</span><div class="bar"><span style="width:${(x.count/max)*100}%"></span></div><b>${fmt(x.count)}</b></div>`).join('')||'<div class="muted">No breakdown returned.</div>'}</div>`; }
function formatShortDate(day){
  const date=new Date(`${day}T00:00:00`);
  if(Number.isNaN(date.getTime())) return String(day||'').slice(5);
  return date.toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
function recentSummaryBlock(chart){
  const total=chart.reduce((a,d)=>a+(Number(d.count)||0),0);
  const activeDays=chart.filter(d=>(Number(d.count)||0)>0).length;
  const peak=chart.reduce((best,d)=>(Number(d.count)||0)>(Number(best?.count)||0)?d:best, chart[0]||null);
  const latest=[...chart].reverse().find(d=>(Number(d.count)||0)>0);
  const avg=activeDays?Math.round(total/activeDays):0;
  const cells=[
    ['Total', fmt(total)],
    ['Active days', `${fmt(activeDays)}/${fmt(chart.length||0)}`],
    ['Peak day', peak?`${fmt(peak.count)} · ${formatShortDate(peak.day)}`:'—'],
    ['Avg / active day', fmt(avg)],
  ];
  return cells.map(([k,v])=>`<div class="recent-mini"><span>${esc(k)}</span><strong title="${esc(v)}">${esc(v)}</strong></div>`).join('');
}
function drawRecent(data){
  const c=$('#recentChart'); if(!c) return;
  const chart=Array.isArray(data)?data.filter(d=>d && d.day):null;
  const summary=$('#recentSummary'); if(summary) summary.innerHTML=chart===null?'<div class="muted">Recent-write history is not exposed by the YantrikDB HTTP API.</div>':recentSummaryBlock(chart);
  const rect=c.getBoundingClientRect();
  const parentW=c.parentElement?.clientWidth || 0;
  const cssW=Math.max(320, Math.floor(rect.width || parentW || 320));
  const cssH=190;
  const dpr=Math.min(devicePixelRatio||1,2);
  c.style.width='100%'; c.style.height=`${cssH}px`;
  c.width=Math.floor(cssW*dpr); c.height=Math.floor(cssH*dpr);
  const ctx=c.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,cssW,cssH);
  ctx.font='12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
  if(chart===null || !chart.length){
    ctx.fillStyle='rgba(255,247,249,.52)';
    ctx.textAlign='center';
    ctx.fillText(chart===null?'Recent-write history is not exposed':'No recent writes returned', cssW/2, cssH/2);
    return;
  }
  const max=Math.max(1,...chart.map(d=>Number(d.count)||0));
  const left=44, right=14, top=14, bottom=34;
  const w=cssW-left-right, h=cssH-top-bottom;
  ctx.strokeStyle='rgba(255,255,255,.12)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(left,top); ctx.lineTo(left,top+h); ctx.lineTo(left+w,top+h); ctx.stroke();
  ctx.fillStyle='rgba(255,247,249,.52)'; ctx.textAlign='right'; ctx.textBaseline='middle';
  [0,.5,1].forEach(t=>{ const y=top+h-(h*t); const v=Math.round(max*t); ctx.fillText(String(v), left-9, y); ctx.strokeStyle='rgba(255,255,255,.055)'; ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(left+w,y); ctx.stroke(); });
  const gap=Math.max(2, Math.min(7, w/90));
  const bw=w/Math.max(1,chart.length);
  chart.forEach((d,i)=>{
    const value=Number(d.count)||0;
    const x=left+i*bw+gap/2;
    const bh=Math.max(value?3:0, h*(value/max));
    const y=top+h-bh;
    const g=ctx.createLinearGradient(0,y,0,top+h); g.addColorStop(0,'#e94560'); g.addColorStop(1,'#ffa500');
    ctx.fillStyle=g; ctx.beginPath(); ctx.roundRect(x,y,Math.max(2,bw-gap),bh,4); ctx.fill();
  });
  const labelEvery=cssW<520?Math.ceil(chart.length/4):Math.ceil(chart.length/6);
  ctx.fillStyle='rgba(255,247,249,.58)'; ctx.textAlign='center'; ctx.textBaseline='top';
  chart.forEach((d,i)=>{ if(i===0 || i===chart.length-1 || i%labelEvery===0){ const x=left+i*bw+bw/2; ctx.fillText(formatShortDate(d.day), x, top+h+10); } });
}

function visualiserColors(){ return viz.mode==='neural' ? {bg:'#050915',core:'rgba(24,130,112,.30)',mid:'rgba(9,14,28,.96)',star:'#66e8c6',memory:'#ff9b6a',text:'#f7f8ff',edge:'rgba(102,232,198,.36)',memoryEdge:'rgba(255,155,106,.44)'} : {bg:'#050711',core:'rgba(233,69,96,.18)',mid:'rgba(9,10,18,.96)',star:'#ffd6dd',memory:'#ffa500',text:'#f7f8ff',edge:'rgba(255,214,221,.30)',memoryEdge:'rgba(255,165,0,.42)'}; }
function setVisualiserMode(mode){ viz.mode=mode||'constellation'; $$('.visualiser-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.vizMode===viz.mode)); document.querySelector('.constellation-wrap')?.setAttribute('data-visualiser',viz.mode); if(viz.data) buildVisualiserScene(viz.data); }
function resetVisualiser(){ Object.assign(viz, DEFAULT_VIZ_CAMERA, {paused:false, interaction:'rotate', drag:null}); $('#vizPause').textContent='Pause rotation'; $('#vizPanMode').textContent='Pan mode'; if(viz.data) buildVisualiserScene(viz.data); }
function stopVisualiser(){ if(viz.frame) cancelAnimationFrame(viz.frame); viz.frame=0; viz.drag=null; }
async function loadVisualiser(force=false){ if(viz.data && !force){ startVisualiser(); return; } const data=await api(`/api/constellation?namespace=${encodeURIComponent(ns())}&limit=260`); buildVisualiserScene(data); }
function buildVisualiserScene(data){
  const nodes=(data.nodes||[]).slice(0,180).map(n=>({...n}));
  const cats=[...new Set(nodes.map(n=>n.category||'Other'))]; const catIndex=Object.fromEntries(cats.map((c,i)=>[c,i]));
  const degree=new Map(); (data.edges||[]).forEach(e=>{degree.set(e.source,(degree.get(e.source)||0)+1);degree.set(e.target,(degree.get(e.target)||0)+1);});
  nodes.forEach((n,i)=>{ const ci=catIndex[n.category||'Other']||0; const angle=(i/Math.max(nodes.length,1))*Math.PI*2+ci*.62; const band=n.kind==='memory'?1.25:.70+(ci%4)*.16; const r=250*band+(i%7)*16; if(viz.mode==='neural'){ const region=(ci-cats.length/2)*84; n.x=Math.cos(angle)*(.38*r)+region; n.y=Math.sin(angle*1.7)*(80+(ci%4)*18); n.z=Math.sin(angle)*(.55*r)+(((i*97)%181)-90)*1.2; } else { n.x=Math.cos(angle)*r; n.y=Math.sin(angle*1.23)*(100+(ci%5)*24)+(((i*53)%131)-65)*.82; n.z=Math.sin(angle)*r*.82+(((i*97)%181)-90)*1.55+((ci%5)-2)*42; } n.size=Math.min(26,5+Math.sqrt(Number(n.weight||n.count||1)+(degree.get(n.id)||0))*3.2)*(n.kind==='memory'?1.08:1); n.twinkle=(i%17)/17; });
  viz.nodes=nodes; viz.byId=Object.fromEntries(nodes.map(n=>[n.id,n])); viz.edges=(data.edges||[]).filter(e=>viz.byId[e.source]&&viz.byId[e.target]).slice(0,360); viz.data=data; viz.stars=Array.from({length:120},(_,i)=>({x:((i*73)%1000)/1000,y:((i*191)%680)/680,r:.35+((i*37)%100)/90,a:.12+((i*29)%100)/260,phase:(i*47)%628/100,freq:.0006+((i*41)%90)/100000}));
  $('#constellationClusters').innerHTML=(data.clusters||[]).map(c=>`<button class="cluster-pill">${esc(c.label)} <strong>${fmt(c.count)}</strong></button>`).join('');
  visualiserInspectorDefault(); startVisualiser();
}
function visualiserInspectorDefault(){ $('#constellationInspector').innerHTML=`<div class="inspector-kicker">${viz.mode==='neural'?'Neural inspector':'Constellation inspector'}</div><h3>Nothing selected</h3><p class="muted">Pick a ${viz.mode==='neural'?'neuron hub, memory soma, or synapse':'star, memory, or link'} to inspect the underlying YantrikDB source.</p>`; }
function inspectVisualNode(node){ $('#constellationInspector').innerHTML=`<div class="inspector-kicker">${esc(node.kind||'entity')}</div><h3>${esc(node.label)}</h3><p class="muted">${esc(node.category||'Other')} · ${fmt(node.count||0)} signal(s) · weight ${Number(node.weight||0).toFixed(2)}</p>${node.preview?`<p>${esc(node.preview)}</p>`:''}<div class="inspector-actions">${node.memory_id?'<button id="vizOpenMemory" class="btn primary tiny">Open memory</button>':''}<button id="vizSearch" class="btn secondary tiny">Search this</button></div>`; if(node.memory_id) $('#vizOpenMemory').onclick=()=>selectMemory(node.memory_id); $('#vizSearch').onclick=()=>{ setView('memories'); $('#memorySearch').value=node.label.replace(/^memory:/,''); state.memoryOffset=0; loadMemories(); }; }
function projectVisualNode(n,w,h){ const cos=Math.cos(viz.rotation), sin=Math.sin(viz.rotation); const xr=n.x*cos-n.z*sin, z0=n.x*sin+n.z*cos; const y=n.y*Math.cos(viz.tilt)-z0*Math.sin(viz.tilt); const z=n.y*Math.sin(viz.tilt)+z0*Math.cos(viz.tilt); const depth=viz.mode==='neural'?920:760; const scale=depth/(depth+z+260); const fit=w<620?Math.min(.78,Math.max(.56,(w-36)/680)):Math.min(1.16,Math.max(.68,(w-72)/760)); return {x:w/2+viz.panX+xr*scale*fit*viz.zoom,y:h/2+viz.panY+y*scale*fit*viz.zoom,z,scale:scale*viz.zoom,visible:scale>.32}; }
function drawVisualFrame(t=0){ const canvas=$('#constellationCanvas'); if(!canvas||state.view!=='visualiser') return; const wrap=canvas.parentElement; const w=Math.max(320,wrap.clientWidth||1000), h=Math.max(430,wrap.clientHeight||680); const dpr=Math.min(devicePixelRatio||1,w<620?2:1.5); if(canvas.width!==Math.floor(w*dpr)||canvas.height!==Math.floor(h*dpr)){canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);} const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); const c=visualiserColors(); if(!viz.paused&&!viz.drag&&!matchMedia('(prefers-reduced-motion: reduce)').matches){ const delta=viz.lastFrameTime?Math.min(48,t-viz.lastFrameTime):16; viz.rotation+=delta*(viz.mode==='neural'?0.000032:0.000045); } viz.lastFrameTime=t; ctx.clearRect(0,0,w,h); const bg=ctx.createRadialGradient(w*.48,h*.42,18,w*.48,h*.42,Math.max(w,h)*.78); bg.addColorStop(0,c.core); bg.addColorStop(.48,c.mid); bg.addColorStop(1,c.bg); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h); viz.stars.forEach(s=>{ctx.globalAlpha=s.a*(.5+Math.sin(t*s.freq+s.phase)*.3);ctx.fillStyle=c.text;ctx.beginPath();ctx.arc(s.x*w,s.y*h,s.r*.7,0,Math.PI*2);ctx.fill();}); const projected=new Map(); viz.nodes.forEach(n=>projected.set(n.id,projectVisualNode(n,w,h))); viz.edges.forEach(e=>{const a=projected.get(e.source),b=projected.get(e.target); if(!a||!b)return; ctx.globalAlpha=e.kind==='memory'?.26:.20; ctx.strokeStyle=e.kind==='memory'?c.memoryEdge:c.edge; ctx.lineWidth=.8; ctx.beginPath(); ctx.moveTo(a.x,a.y); const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,dx=b.x-a.x,dy=b.y-a.y,len=Math.max(1,Math.hypot(dx,dy)),curve=Math.min(42,len*.15)*(((e.id||'').length%2)?1:-1); ctx.quadraticCurveTo(mx-dy/len*curve,my+dx/len*curve,b.x,b.y); ctx.stroke(); }); const hits=[]; [...viz.nodes].sort((a,b)=>(projected.get(a.id)?.z||0)-(projected.get(b.id)?.z||0)).forEach(n=>{const p=projected.get(n.id); if(!p?.visible)return; const base=n.kind==='memory'?c.memory:c.star; const r=Math.min(18,Math.max(4,n.size*p.scale)); const pulse=1+Math.sin(t*.0015+n.twinkle*6.28)*.07; const halo=r*(n.kind==='memory'?2.1:2.5); const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,halo); g.addColorStop(0,'rgba(255,255,255,.86)'); g.addColorStop(.22,base); g.addColorStop(1,'rgba(0,0,0,0)'); ctx.globalAlpha=.28; ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.x,p.y,halo,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=.95; ctx.fillStyle=base; ctx.beginPath(); ctx.arc(p.x,p.y,r*pulse,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=.9; ctx.fillStyle='rgba(255,255,255,.88)'; ctx.beginPath(); ctx.arc(p.x-r*.18,p.y-r*.22,Math.max(1,r*.23),0,Math.PI*2); ctx.fill(); if(w>520||n.kind!=='memory'){ ctx.globalAlpha=.78; ctx.fillStyle=c.text; ctx.font=`${n.kind==='memory'?10:12}px Inter, sans-serif`; ctx.textAlign='center'; ctx.fillText(String(n.label||'').slice(0,22),p.x,p.y+r+14); } hits.push({node:n,x:p.x,y:p.y,r:Math.max(r+8,14)}); }); viz.hits=hits; ctx.globalAlpha=1; viz.frame=requestAnimationFrame(drawVisualFrame); }
function startVisualiser(){ stopVisualiser(); viz.frame=requestAnimationFrame(drawVisualFrame); }
function bindVisualiserEvents(){ const canvas=$('#constellationCanvas'); if(!canvas||canvas.dataset.bound)return; canvas.dataset.bound='1'; const point=e=>{const r=canvas.getBoundingClientRect(); const t=e.touches?.[0]||e; return {x:t.clientX-r.left,y:t.clientY-r.top};}; const down=e=>{ if(e.button===2 && e.cancelable) e.preventDefault(); const p=point(e); const rightPan=e.button===2; if(!rightPan){ const hit=[...(viz.hits||[])].reverse().find(h=>Math.hypot(h.x-p.x,h.y-p.y)<=h.r); if(hit){inspectVisualNode(hit.node); return;} } viz.drag={x:p.x,y:p.y,rot:viz.rotation,tilt:viz.tilt,panX:viz.panX,panY:viz.panY,pan:rightPan||e.shiftKey||viz.interaction==='pan'}; canvas.setPointerCapture?.(e.pointerId);}; const move=e=>{ if(!viz.drag)return; const p=point(e), dx=p.x-viz.drag.x, dy=p.y-viz.drag.y; if(viz.drag.pan){viz.panX=viz.drag.panX+dx;viz.panY=viz.drag.panY+dy;} else {viz.rotation=viz.drag.rot+dx*.006;viz.tilt=Math.max(.15,Math.min(1.35,viz.drag.tilt+dy*.004));} }; const up=()=>{viz.drag=null;}; canvas.addEventListener('contextmenu',e=>e.preventDefault()); canvas.addEventListener('pointerdown',down); canvas.addEventListener('pointermove',move); canvas.addEventListener('pointerup',up); canvas.addEventListener('pointercancel',up); canvas.addEventListener('wheel',e=>{e.preventDefault(); viz.zoom=Math.max(.45,Math.min(4,viz.zoom*(e.deltaY>0?.92:1.09)));},{passive:false}); }

async function loadMemories(){
  const params=new URLSearchParams({namespace:ns(),status:$('#statusFilter')?.value||'active',domain:$('#domainFilter')?.value||'',sort:$('#sortFilter')?.value||'created_at',limit:50,offset:state.memoryOffset});
  try{
    const data=await api('/api/memories?'+params);
    const items=Array.isArray(data.items)?data.items:[];
    state.namespaceTags=[...new Set([...(state.namespaceTags||[]),...items.map(item=>item.namespace).filter(value=>typeof value==='string')])];
    const filter=($('#memorySearch')?.value||'').trim().toLowerCase();
    const visible=filter?items.filter(item=>JSON.stringify(item).toLowerCase().includes(filter)):items;
    $('#memoryList').innerHTML=visible.map(memoryItem).join('') || (filter?'<div class="empty helpful-empty"><strong>No matches on this page.</strong><span>The list endpoint does not support server-side text search. Use Recall for semantic search or clear this page filter.</span></div>':'<div class="empty helpful-empty"><strong>No memories found.</strong><span>Try clearing the domain filter or switching namespace.</span></div>');
    $$('#memoryList .memory-item').forEach(el=>el.onclick=()=>selectMemory(el.dataset.rid));
    const total=typeof data.total==='number'?data.total:null;
    const shownEnd=total===null?null:Math.min(state.memoryOffset+items.length,total);
    $('#memoryPager').innerHTML=`<button class="btn secondary" ${state.memoryOffset<=0?'disabled':''} id="prevPage">Prev</button><span>${fmt(state.memoryOffset+1)}–${fmt(shownEnd)} of ${fmt(total)}</span><button class="btn secondary" ${total===null || state.memoryOffset+50>=total?'disabled':''} id="nextPage">Next</button>`;
    $('#prevPage')?.addEventListener('click',()=>{state.memoryOffset=Math.max(0,state.memoryOffset-50);loadMemories();});
    $('#nextPage')?.addEventListener('click',()=>{state.memoryOffset+=50;loadMemories();});
    const options=namespaceOptions(ns());
    ['#scopeSelect','#memoryNamespaceFilter'].forEach(selector=>{const select=$(selector);if(select){select.innerHTML=options;select.value=ns();}});
    updateScopeUi();
  }catch(e){
    $('#memoryList').innerHTML=`<div class="empty helpful-empty"><strong>Memory list request failed.</strong><span>${esc(e.message)}</span></div>`;
    $('#memoryPager').innerHTML='';
  }
}
function statusLabel(status){ return status==='tombstoned'?'forgotten':(status||'active'); }
function statusPillClass(status){ const value=String(status||'active'); return value==='active'?'good':(value==='tombstoned'?'hot':'neutral'); }
function shortNamespace(value){ const raw=String(value??''); return raw===''?'(empty)':(raw.split(':').slice(-2).join(':')||raw); }
function memoryItem(m){
  const showNs=ns()===ALL_NAMESPACES;
  return `<div class="memory-item" data-rid="${esc(m.rid)}">
    <div class="memory-headline"><div class="memory-title">${esc(m.domain||'general')} <span class="muted">· ${esc(m.type)}</span></div>${showNs?`<span class="namespace-chip" title="${esc(m.namespace||'')}">${esc(shortNamespace(m.namespace))}</span>`:''}</div>
    <div class="memory-text">${esc(m.text)}</div>
    <div class="meta-row"><span class="pill ${statusPillClass(m.consolidation_status)}">${esc(statusLabel(m.consolidation_status))}</span><span class="pill">importance ${Number(m.importance||0).toFixed(2)}</span><span class="pill">${esc(m.source||'source')}</span><span class="pill">${esc(m.created_at_iso||'')}</span></div>
  </div>`;
}
async function selectMemory(rid, opts={}){
  state.selectedMemory=rid;
  $$('#memoryList .memory-item').forEach(x=>x.classList.toggle('active',x.dataset.rid===rid));
  const m=await api('/api/memory/'+encodeURIComponent(rid)+'?namespace='+encodeURIComponent(ns()));
  $('.drawer-title').textContent='YantrikDB memory';
  $('#memoryDrawerBody').innerHTML=detailHtml(m);
  $$('[data-copy-value]').forEach(button=>button.addEventListener('click',()=>showSelectableCopy(button.dataset.copyLabel||'Value',button.dataset.copyValue||'')));
  $('#copyDrawerRid')?.addEventListener('click',event=>showSelectableCopy('RID',event.currentTarget.dataset.rid||''));
  $('#forgetDrawerMemory')?.addEventListener('click',event=>forgetSelected(event.currentTarget.dataset.rid||''));
  $('#memoryDrawer').classList.remove('hidden');
  if(opts.updateUrl!==false){
    if(state.view!=='memories') setView('memories',{updateUrl:false});
    const url=routeUrlFor('memories'); url.searchParams.set('memory',rid);
    history.pushState({view:'memories',memory:rid},'',url);
  }
}
function closeMemoryDetail(opts={}){
  $('#memoryDrawer')?.classList.add('hidden');
  state.selectedMemory=null;
  if(!opts.silent){
    $$('#memoryList .memory-item').forEach(x=>x.classList.remove('active'));
    if(state.view==='memories' && new URLSearchParams(location.search).has('memory')) writeRoute('memories',{replace:true});
  }
}
function detailHtml(m){
  const title=esc(m.domain||m.type||'Memory');
  const status=esc(m.consolidation_status||'active');
  const rid=esc(m.rid||'');
  return `<section class="memory-detail-shell">
    <div class="memory-detail-kicker">${esc(m.type||'semantic')} · ${status}</div>
    <h2 class="memory-detail-title">${title}</h2>
    <div class="detail-content">${esc(m.text)}</div>
    <div class="drawer-actions">
      <button id="copyDrawerRid" class="drawer-action" data-rid="${rid}">Copy RID</button>
      <button id="forgetDrawerMemory" class="drawer-action danger" data-rid="${rid}">Forget memory</button>
    </div>
    <div class="diag-grid">
      ${diag('RID', rid, true)}${diag('Namespace', m.namespace, true)}${diag('Source', m.source)}${diag('Type', m.type)}${diag('Importance', Number(m.importance||0).toFixed(3))}${diag('Certainty', Number(m.certainty||0).toFixed(3))}${diag('Access count', m.access_count)}${diag('Created', m.created_at_iso)}${diag('Updated', m.updated_at_iso)}${diag('Embedding bytes', m.embedding_bytes)}
    </div>
    ${arrSection('Metadata', m.metadata_json||{})}${arrSection('Entities',m.entities)}${arrSection('Claims',m.claims)}${arrSection('Consolidation',m.consolidation_sources)}
  </section>`;
}
function diag(k,v,copy=false){ const val=fmt(v); return `<div class="diag-row"><span>${esc(k)}</span><strong>${copy?`<button type="button" class="diag-link" data-copy-label="${esc(k)}" data-copy-value="${esc(val)}">${esc(val)}</button>`:esc(val)}</strong></div>`; }
function kv(k,v){return `<div>${esc(k)}</div><div>${esc(fmt(v))}</div>`}
function arrSection(title, arr){ if(!arr||(Array.isArray(arr)&&!arr.length)||(typeof arr==='object'&&!Array.isArray(arr)&&!Object.keys(arr).length))return ''; return `<div class="detail-section"><div class="label">${title}</div><pre>${esc(JSON.stringify(arr,null,2))}</pre></div>`; }
function showSelectableCopy(label,value){ const text=String(value||''); if(navigator.clipboard?.writeText){ navigator.clipboard.writeText(text).then(()=>toast(`${label} copied`)).catch(()=>toast(text)); } else { toast(text); } }
function confirmAction(title,message){ return new Promise(resolve=>{ const modal=$('#confirmModal'); $('#confirmTitle').textContent=title; $('#confirmMessage').textContent=message; modal.classList.remove('hidden'); const done=v=>{modal.classList.add('hidden'); $('#confirmOk').onclick=null; $('#confirmCancel').onclick=null; resolve(v);}; $('#confirmOk').onclick=()=>done(true); $('#confirmCancel').onclick=()=>done(false); modal.onclick=e=>{ if(e.target===modal) done(false); }; }); }
async function forgetSelected(rid){ if(!await confirmAction('Forget this memory?','This removes the memory from active recall and keeps an audit record. Admin Mode must be enabled.'))return; try{ const out=await api(`/api/memory/${encodeURIComponent(rid)}/forget?namespace=${encodeURIComponent(ns())}`,{method:'POST',body:'{}'}); toast('Memory forgotten'); await loadMemories(); $('#memoryDrawerBody').innerHTML=`<pre>${esc(JSON.stringify(out,null,2))}</pre>`;}catch(e){toast(e.message)} }

function renderScoreBreakdown(scores={}){
  const contributions = scores.contributions || {};
  const entries = Object.entries(contributions).filter(([,v])=>Number.isFinite(Number(v)) && Number(v)!==0);
  if(!entries.length) return '';
  const max = Math.max(...entries.map(([,v])=>Math.abs(Number(v))), .001);
  return `<div class="score-breakdown" aria-label="Recall score contribution breakdown">${entries.map(([name,value])=>{
    const width=Math.max(4, Math.round((Math.abs(Number(value))/max)*100));
    return `<div class="score-contrib"><span>${esc(name.replace(/_/g,' '))}</span><div class="score-contrib-track"><i class="score-contrib-bar" style="width:${width}%"></i></div><strong>${Number(value).toFixed(3)}</strong></div>`;
  }).join('')}</div>`;
}

async function runRecall(){
  const body={query:$('#recallQuery').value,top_k:Number($('#recallTopK').value||10),namespace:ns(),domain:$('#recallDomain').value||null,source:$('#recallSource').value||null,include_consolidated:$('#recallConsolidated').checked,expand_entities:$('#recallGraph').checked};
  const data=await api('/api/recall',{method:'POST',body:JSON.stringify(body)});
  const results=data.results||data.items||[];
  $('#recallResults').innerHTML=`<div class="panel"><div class="panel-head"><h2>Results</h2><span class="muted">${fmt(results.length)} hits</span></div>${(data.certainty_reasons||[]).map(x=>`<span class="pill warn">${esc(x)}</span>`).join('')}</div>`+results.map((r,i)=>`<div class="recall-card"><div class="panel-head"><h2>#${i+1} ${esc(r.domain||r.type||'memory')}</h2><div class="recall-score">${Number(r.score||r.similarity||0).toFixed(3)}</div></div><p>${esc(r.text||r.content||JSON.stringify(r).slice(0,500))}</p>${renderScoreBreakdown(r.scores||{})}<div class="meta-row">${(r.why_retrieved||r.reasons||[]).map(x=>`<span class="pill good">${esc(x)}</span>`).join('')}<span class="pill">${esc(r.rid||'')}</span></div><details class="details-block"><summary>Raw recall row</summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details></div>`).join('') || `<div class="empty">No recall results.</div>`;
}

function renderSkillRecallCards(data){
  const cards=$('#skillRecallCards'); if(!cards) return;
  const capabilities=[
    ['Semantic search','POST /v1/skills/search'],
    ['Exact skill read','GET /v1/skills/{id}'],
    ['Record outcome','POST /v1/skills/{id}/outcome'],
    ['Outcome history','Not exposed'],
    ['Recent surfacing','Not exposed'],
  ];
  cards.innerHTML=capabilities.map(([label,value])=>`<div class="stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div></div>`).join('');
  $('#skillRecallStatus').textContent=`HTTP backend · ${data.search_endpoint}`;
  const warning=$('#skillRecallWarning');
  if(warning){ warning.textContent='Outcome writes are supported; reading outcome history and recent surfacing history are not. The dashboard does not fabricate either view.'; warning.classList.remove('hidden'); }
}
async function loadSkillRecallStatus(){
  try{ renderSkillRecallCards(await api('/api/skill-recall/status')); }
  catch(e){ if($('#skillRecallStatus')) $('#skillRecallStatus').textContent=e.message; }
}
function renderSkillCard(skill){
  const id=skill.skill_id||skill.rid||'Unknown skill';
  const score=Number.isFinite(Number(skill.score))?Number(skill.score).toFixed(3):'—';
  const tags=Array.isArray(skill.applies_to)?skill.applies_to.join(', '):'';
  return `<article class="memory-item skill-card" data-skill-id="${esc(id)}"><div class="memory-title">${esc(id)} <span class="muted">${esc(skill.skill_type||'skill')}</span></div><div class="memory-text">${esc((skill.body||'').slice(0,420)||'Open to read the returned skill body.')}</div><div class="meta-row"><span class="pill good">score ${esc(score)}</span><span class="pill">${esc(tags||'No tags returned')}</span></div></article>`;
}
async function runSkillSearch(){
  const query=$('#skillSearchQuery')?.value?.trim()||'';
  if(!query){ toast('Enter a skill search query'); return; }
  const body={query,top_k:Number($('#skillSearchTopK')?.value||5),applies_to:$('#skillSearchAppliesTo')?.value?.trim()||null};
  try{
    const data=await api('/api/skill-recall/search',{method:'POST',body:JSON.stringify(body)});
    const items=Array.isArray(data.items)?data.items:[];
    $('#skillSearchResults').innerHTML=items.map(renderSkillCard).join('')||'<div class="empty helpful-empty"><strong>No skills matched.</strong><span>The response was returned by YantrikDB; check the query, server token, and whether skills are enabled.</span></div>';
    $$('#skillSearchResults .skill-card').forEach((el,index)=>el.onclick=()=>showSkillOutcome(items[index]));
    if(items[0]) showSkillOutcome(items[0]);
    else if($('#skillOutcomeDetail')) $('#skillOutcomeDetail').innerHTML='<div class="empty">No skill record selected.</div>';
  }catch(e){
    toast(e.message);
    $('#skillSearchResults').innerHTML=`<div class="empty">${esc(e.message)}</div>`;
  }
}
async function showSkillOutcome(hit){
  const id=hit.skill_id||hit.rid||'';
  const panel=$('#skillOutcomeDetail'); if(!panel) return;
  if(!id){ panel.innerHTML='<div class="empty">The server result did not include a skill ID.</div>'; return; }
  panel.innerHTML='<div class="empty">Loading exact skill record…</div>';
  try{
    const result=await api(`/api/skill-recall/${encodeURIComponent(id)}`);
    const skill=result.skill||result;
    const body=skill.body||skill.text||skill.content||hit.body||'';
    const tags=Array.isArray(skill.applies_to)?skill.applies_to:(Array.isArray(hit.applies_to)?hit.applies_to:[]);
    panel.innerHTML=`<div class="detail"><h2>${esc(skill.skill_id||id)}</h2><div class="meta-row">${tags.map(tag=>`<span class="pill">${esc(tag)}</span>`).join('')}<span class="pill good">${esc(skill.skill_type||hit.skill_type||'skill')}</span></div><pre>${esc(body||'No body was returned.')}</pre><div class="detail-section"><div class="label">Record an outcome</div><p class="muted">This writes one success/failure result to YantrikDB. Outcome history is not readable through the HTTP API.</p><textarea id="skillOutcomeContext" placeholder="Optional outcome context"></textarea><div class="toolbar compact"><button class="btn primary" id="skillOutcomeSuccess" type="button">Record success</button><button class="btn secondary" id="skillOutcomeFailure" type="button">Record failure</button></div></div></div>`;
    $('#skillOutcomeSuccess')?.addEventListener('click',()=>recordSkillOutcome(id,true));
    $('#skillOutcomeFailure')?.addEventListener('click',()=>recordSkillOutcome(id,false));
  }catch(e){ panel.innerHTML=`<div class="empty">${esc(e.message)}</div>`; }
}
async function recordSkillOutcome(id, success){
  try{
    const context=$('#skillOutcomeContext')?.value||'';
    const result=await api(`/api/skill-recall/${encodeURIComponent(id)}/outcome`,{method:'POST',body:JSON.stringify({success,context})});
    toast('YantrikDB recorded the skill outcome');
    const panel=$('#skillOutcomeDetail');
    panel?.insertAdjacentHTML('beforeend',`<details class="details-block"><summary>Outcome write response</summary><pre>${esc(JSON.stringify(result,null,2))}</pre></details>`);
  }catch(e){ toast(e.message); }
}

async function loadConflicts(){
  try{
    const data=await api(`/api/conflicts?namespace=${encodeURIComponent(ns())}&status=${encodeURIComponent($('#conflictStatus')?.value||'')}`);
    const items=Array.isArray(data.items)?data.items:[];
    $('#conflictList').innerHTML=items.map((conflict,index)=>`<div class="memory-item" data-index="${index}"><div class="memory-title">${esc(conflict.conflict_type||conflict.type||'Conflict')} <span class="muted">${esc(conflict.status||'unknown')}</span></div><div class="memory-text">${esc(conflict.description||conflict.summary||JSON.stringify(conflict).slice(0,220))}</div><div class="meta-row"><span class="pill warn">priority ${esc(conflict.priority??'—')}</span><span class="pill">${esc(conflict.entity||'')}</span></div></div>`).join('')||'<div class="empty">No conflicts were returned.</div>';
    $$('#conflictList .memory-item').forEach((element,index)=>element.onclick=()=>selectConflict(items[index]));
    if($('#conflictDetail')) $('#conflictDetail').innerHTML='<div class="empty">Select a conflict record returned by YantrikDB.</div>';
  }catch(e){ $('#conflictList').innerHTML=`<div class="empty">${esc(e.message)}</div>`; }
}
function selectConflict(conflict){
  const id=conflict.conflict_id||conflict.id||'';
  const panel=$('#conflictDetail'); if(!panel) return;
  const claims=[conflict.claim_a,conflict.claim_b,conflict.left,conflict.right].filter(Boolean);
  const strategies=Array.isArray(conflict.allowed_strategies)?conflict.allowed_strategies:['dismiss','keep_winner','merge','keep_both'];
  panel.innerHTML=`<div class="detail"><h2>Conflict ${esc(id||'')}</h2><pre>${esc(JSON.stringify(conflict,null,2))}</pre>${claims.length?`<div class="detail-section"><div class="label">Returned claims</div>${claims.map(claim=>`<div class="memory-item"><pre>${esc(JSON.stringify(claim,null,2))}</pre></div>`).join('')}</div>`:''}<div class="detail-section"><div class="label">Resolve</div><div class="toolbar compact"><select id="resolveStrategy">${strategies.map(strategy=>`<option value="${esc(strategy)}">${esc(strategy)}</option>`).join('')}</select><input id="winnerRid" placeholder="Winner RID (if required)"><input id="newText" placeholder="Merged text (if required)"><button class="btn primary" id="resolveConflictButton" type="button">Resolve</button></div></div></div>`;
  $('#resolveConflictButton')?.addEventListener('click',()=>resolveConflict(id));
}
async function resolveConflict(id){
  try{
    const body={strategy:$('#resolveStrategy')?.value||'dismiss',winner_rid:$('#winnerRid')?.value||null,new_text:$('#newText')?.value||null,resolution_note:'Resolved via YantrikDB Dashboard'};
    const result=await api(`/api/conflicts/${encodeURIComponent(id)}/resolve`,{method:'POST',body:JSON.stringify(body)});
    $('#conflictDetail').innerHTML=`<pre>${esc(JSON.stringify(result,null,2))}</pre>`;
    await loadConflicts();
  }catch(e){ toast(e.message); }
}
async function loadEntities(){
  if($('#entityList')) $('#entityList').innerHTML='<div class="empty helpful-empty"><strong>Entity index unavailable.</strong><span>YantrikDB exposes claims for a known entity but not an all-entities index. The dashboard will not infer entities from text.</span></div>';
}
async function loadGraph(){
  if($('#graphMeta')) $('#graphMeta').textContent='Not available: no graph-edge read route in the current YantrikDB HTTP contract.';
}

function triggerId(t){ return t.trigger_id || t.id || ''; }
function renderTrigger(t){
  const id=triggerId(t);
  const status=t.status || 'pending';
  return `<div class="memory-item trigger-card"><div class="memory-title">${esc(t.trigger_type||t.type||'trigger')} <span class="muted">${esc(status)}</span></div><div class="memory-text">${esc(t.reason||t.description||JSON.stringify(t).slice(0,220))}</div><div class="meta-row"><span class="pill warn">urgency ${Number(t.urgency||0).toFixed(2)}</span><span class="pill">${esc(t.suggested_action||'review')}</span><span class="pill">${esc(id)}</span></div>${status==='pending'&&id?`<div class="trigger-actions"><button class="btn secondary tiny" data-trigger-action="acknowledge" data-trigger-id="${esc(id)}">Acknowledge</button><button class="btn ghost tiny" data-trigger-action="dismiss" data-trigger-id="${esc(id)}">Dismiss</button><button class="btn primary tiny" data-trigger-action="act" data-trigger-id="${esc(id)}">Mark acted</button></div>`:''}<details class="details-block"><summary>Trigger details</summary><pre>${esc(JSON.stringify(t,null,2))}</pre></details></div>`;
}
async function triggerAction(id, action, label){
  try{ await api(`/api/triggers/${encodeURIComponent(id)}/${action}`,{method:'POST',body:'{}'}); toast(label); await loadLifecycle(); }
  catch(e){ toast(e.message); }
}
async function acknowledgeTrigger(id){ return triggerAction(id,'acknowledge','Trigger acknowledged'); }
async function dismissTrigger(id){ if(!await confirmAction('Dismiss trigger?','This closes the trigger without recording follow-up action. Admin Mode must be enabled.')) return; return triggerAction(id,'dismiss','Trigger dismissed'); }
async function actOnTrigger(id){ return triggerAction(id,'act','Trigger marked acted-on'); }
function unavailableList(error){ return `<div class="empty helpful-empty"><strong>Unavailable</strong><span>${esc(error)}</span></div>`; }
async function getCapability(path){
  try{ return {data:await api(path),error:null}; }
  catch(error){ return {data:null,error:error.message||String(error)}; }
}
async function loadLifecycle(){
  const requests=await Promise.all([
    getCapability(`/api/stale?namespace=${encodeURIComponent(ns())}`),
    getCapability(`/api/upcoming?namespace=${encodeURIComponent(ns())}`),
    getCapability('/api/patterns'),
    getCapability('/api/triggers?limit=50'),
  ]);
  const [stale,upcoming,patterns,triggers]=requests;
  const countOf=result=>result.error?'—':fmt((result.data?.items||[]).length);
  if($('#lifecycleCards')) $('#lifecycleCards').innerHTML=[['Stale candidates',countOf(stale)],['Upcoming',countOf(upcoming)],['Patterns',countOf(patterns)],['Triggers',countOf(triggers)]].map(([label,value])=>`<div class="stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div></div>`).join('');
  if($('#staleList')) $('#staleList').innerHTML=stale.error?unavailableList(stale.error):((stale.data?.items||[]).map(memoryItem).join('')||'<div class="empty">No stale memories returned.</div>');
  if($('#upcomingList')) $('#upcomingList').innerHTML=upcoming.error?unavailableList(upcoming.error):((upcoming.data?.items||[]).map(memoryItem).join('')||'<div class="empty">No upcoming memories returned.</div>');
  if($('#patternList')) $('#patternList').innerHTML=patterns.error?unavailableList(patterns.error):((patterns.data?.items||[]).map(item=>`<div class="memory-item"><div class="memory-title">${esc(item.pattern_type||item.type||'pattern')}</div><pre>${esc(JSON.stringify(item,null,2))}</pre></div>`).join('')||'<div class="empty">No patterns returned.</div>');
  if($('#triggerList')) {
    $('#triggerList').innerHTML=triggers.error?unavailableList(triggers.error):((triggers.data?.items||[]).map(renderTrigger).join('')||'<div class="empty">No triggers returned.</div>');
    $$('[data-trigger-action]').forEach(button=>button.addEventListener('click',()=>{
      const id=button.dataset.triggerId||'';
      if(button.dataset.triggerAction==='acknowledge') acknowledgeTrigger(id);
      else if(button.dataset.triggerAction==='dismiss') dismissTrigger(id);
      else if(button.dataset.triggerAction==='act') actOnTrigger(id);
    }));
  }
}
async function runThink(){
  if(ns()!==ALL_NAMESPACES){ toast('Select All namespaces; this server maintenance endpoint is database-wide.'); return; }
  if(!await confirmAction('Run maintenance pass?','This runs the YantrikDB server-wide maintenance operation. Admin Mode must be enabled.')) return;
  const button=$('#runThink'); const oldText=button?.textContent;
  try{
    if(button){button.disabled=true;button.textContent='Running…';}
    $('#opsDetails')?.setAttribute('open',''); $('#opsOutput').textContent='Running server-wide maintenance…';
    const result=await api('/api/think',{method:'POST',body:JSON.stringify({run_consolidation:true,run_conflict_scan:true,run_pattern_mining:false,run_personality:false,namespace:ALL_NAMESPACES})});
    $('#opsOutput').textContent=JSON.stringify(result,null,2); toast('Maintenance response received from YantrikDB'); await loadStats();
  }catch(error){ $('#opsDetails')?.setAttribute('open',''); $('#opsOutput').textContent=error.message; toast(error.message); }
  finally{ if(button){button.disabled=false;button.textContent=oldText||'Run pass';} }
}
function renderHygiene(hygiene){
  const summary=hygiene?.summary||{};
  if($('#hygieneCards')) $('#hygieneCards').innerHTML=[
    ['Open conflicts',summary.open_conflicts],
    ['Low-usefulness','Not exposed'],
    ['Active memories',summary.active_memories],
    ['Forgotten',summary.tombstoned_memories],
  ].map(([label,value])=>`<div class="stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(fmt(value))}</div></div>`).join('');
  if($('#recallFeedbackCards')) $('#recallFeedbackCards').innerHTML='<div class="stat-card"><div class="stat-label">Recall feedback</div><div class="stat-value">Not exposed by server</div></div>';
  const conflicts=Array.isArray(hygiene?.open_conflicts)?hygiene.open_conflicts:[];
  if($('#hygieneList')) $('#hygieneList').innerHTML=conflicts.map(item=>`<div class="memory-item"><div class="memory-title">${esc(item.conflict_type||item.type||'Conflict')} <span class="muted">${esc(item.status||'open')}</span></div><pre>${esc(JSON.stringify(item,null,2))}</pre></div>`).join('')||'<div class="empty helpful-empty"><strong>No open conflicts returned.</strong><span>Low-usefulness candidates are unavailable because the server does not expose recall-feedback history.</span></div>';
}
async function loadHygienePanel(){ const hygiene=await api(`/api/hygiene?namespace=${encodeURIComponent(ns())}`); renderHygiene(hygiene); return hygiene; }
async function runHygieneScan(){
  const button=$('#runHygieneScan'); const oldText=button?.textContent;
  try{
    if(button){button.disabled=true;button.textContent='Scanning…';}
    const hygiene=await loadHygienePanel(); $('#opsDetails')?.setAttribute('open',''); $('#opsOutput').textContent=JSON.stringify(hygiene,null,2); toast('YantrikDB hygiene data loaded');
  }catch(error){ $('#opsDetails')?.setAttribute('open',''); $('#opsOutput').textContent=error.message; toast(error.message); }
  finally{ if(button){button.disabled=false;button.textContent=oldText||'Scan';} }
}
async function loadHealthPanel(){
  try{
    const health=await api('/api/health');
    state.health={...state.health,...health};
    await loadIdentityScope();
    if($('#healthPayload')) $('#healthPayload').textContent=JSON.stringify({...health,namespaces:state.health.namespaces||[]},null,2);
    updateScopeUi();
  }catch(error){ if($('#healthPayload')) $('#healthPayload').textContent=error.message; }
}


// Direct Mnemosyne Three.js visualiser port. Keep this close to mnemosyne-dashboard/static/app.js.
function visualiserResponsiveFill(width, height){
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  if(w < 760 || h < 520) return 1;
  const widthFill = Math.max(0, Math.min(1, (w - 760) / 760));
  const heightFill = Math.max(0, Math.min(1, (h - 520) / 360));
  return 1 + Math.min(.22, (widthFill * .16) + (heightFill * .06));
}
function constellationColors(){
  return { light:false, bg:'#050711', star:'#ffd6dd', memory:'#ffa500', text:'rgba(244,248,255,.92)' };
}
function neuralColors(){
  return { light:false, bg:'#050915', star:'#66e8c6', memory:'#ff9b6a', text:'rgba(244,248,255,.92)' };
}
function cityColors(){
  return { light:false, bg:'#06070b', star:'#ffd166', memory:'#7dd3fc', text:'rgba(248,250,252,.94)' };
}
let threeModulePromise = null;
let threeVis = {
  mode: 'constellation', data: null, renderer: null, scene: null, camera: null, group: null,
  nodes: [], edgePairs: [], labels: [], pulses: [], frame: 0, paused: false, panMode: false,
  drag: null, pointer: new Map(), yaw: 0, pitch: 0.32, cameraZ: 780, panX: 0, panY: 0, lastT: 0, lastRenderT: 0,
  selectedNode: null, replay: null, replayNodes: new Set(), replayEdges: new Set()
};
function loadThreeModule(){
  if(!threeModulePromise) threeModulePromise = import('/static/vendor/three.module.min.js');
  return threeModulePromise;
}
function threeInspectorDefault(){
  const mode = threeVis.mode;
  threeVis.selectedNode = null;
  const insp=$('#threeInspector'); if(insp) insp.innerHTML = mode === 'neural'
    ? `<div class="inspector-kicker">Neural inspector</div><h3>Nothing selected</h3><p class="muted">Pick a neuron hub, memory soma, or synapse to inspect the underlying read-only source.</p>`
    : mode === 'city'
      ? `<div class="inspector-kicker">Memory City inspector</div><h3>Nothing selected</h3><p class="muted">Pick a district, landmark, or memory building to inspect the underlying read-only source.</p>`
      : `<div class="inspector-kicker">Constellation inspector</div><h3>Nothing selected</h3><p class="muted">Pick a star, memory, or link to inspect the underlying read-only source.</p>`;
  hideThreeFullscreenInspector();
}
function hideThreeFullscreenInspector(){
  const overlay = $('#threeFullscreenInspector');
  if(!overlay) return;
  overlay.classList.remove('active');
  overlay.innerHTML = '';
}
function exitFullscreenThen(fn){
  const run = () => { try { fn(); } catch(e) { toast(e.message || String(e)); } };
  if(document.fullscreenElement) document.exitFullscreen().then(run).catch(run);
  else run();
}
function threeInspectorMarkup(node, target='panel'){
  const mode = threeVis.mode === 'neural' ? 'Neural Map 3D' : (threeVis.mode === 'city' ? 'Memory City 3D' : 'Constellation 3D');
  const overlay = target === 'overlay';
  const memoryId = overlay ? 'threeOverlayMemory' : 'threeMemory';
  const searchId = overlay ? 'threeOverlaySearch' : 'threeSearch';
  const close = overlay ? '<button id="threeOverlayClose" class="btn ghost tiny" aria-label="Close fullscreen inspector">Close</button>' : '';
  const preview = node.preview ? `<p>${esc(node.preview)}</p>` : '';
  const replay = replayStateForNode(node);
  const health = node.health?.tags?.length ? ` · ${node.health.tags.join(', ')}` : '';
  const group = node.layout_district || node.layout_region || node.category || 'Other';
  const replayCopy = replay ? `<span class="pill good">recall replay: ${esc(replay)}</span>` : '';
  return `<div class="inspector-kicker">${mode} · ${esc(node.kind || 'entity')}</div><h3>${esc(node.label)}</h3><p class="muted">${esc(group)} · ${Number(node.count || 0).toLocaleString()} signal(s) · weight ${Number(node.weight || 0).toFixed(2)}${esc(health)}</p>${preview}<div class="meta-row">${replayCopy}</div><div class="inspector-actions">${node.memory_id ? `<button id="${memoryId}" class="btn primary tiny">Open memory</button>` : ''}<button id="${searchId}" class="btn secondary tiny">Search this</button>${close}</div>`;
}
function bindThreeInspectorActions(node, target='panel'){
  const overlay = target === 'overlay';
  const memory = $(overlay ? '#threeOverlayMemory' : '#threeMemory');
  const search = $(overlay ? '#threeOverlaySearch' : '#threeSearch');
  const close = $('#threeOverlayClose');
  if(memory) memory.onclick = () => exitFullscreenThen(() => selectMemory(node.memory_id));
  if(search) search.onclick = () => exitFullscreenThen(() => visualiserSearchNode(node));
  if(close) close.onclick = hideThreeFullscreenInspector;
}
function visualiserSearchNode(node){
  const rid = String(node.memory_id || '').trim();
  const label = String(node.label || '').replace(/^memory:/,'').trim();
  const preview = String(node.preview || '').replace(/\s+/g,' ').trim();
  const q = rid || preview.slice(0,80) || label;
  state.memoryOffset=0;
  setView('memories',{query:{q,status:'all',domain:'',source:'',sort:'created_at'}});
  loadMemories().then(()=>{ if(rid) selectMemory(rid); }).catch(e=>toast(e.message));
}
function inspectThreeNode(node){
  threeVis.selectedNode = node;
  $('#threeInspector').innerHTML = threeInspectorMarkup(node, 'panel');
  bindThreeInspectorActions(node, 'panel');
  const overlay = $('#threeFullscreenInspector');
  if(overlay){
    overlay.innerHTML = threeInspectorMarkup(node, 'overlay');
    overlay.classList.add('active');
    bindThreeInspectorActions(node, 'overlay');
  }
}
function updateThreeUI(){
  $$('.visualiser-tabs button[data-three-mode]').forEach(b => b.classList.toggle('active', b.dataset.threeMode === threeVis.mode));
  const compact = window.matchMedia('(max-width: 760px)').matches;
  const cityXray = threeVis.mode === 'city' && compact;
  const viewport = $('#threeViewport');
  if(viewport){ viewport.dataset.threeMode = threeVis.mode; viewport.dataset.cityStyle = cityXray ? 'xray' : ''; }
  const legend = $('#threeLegend');
  if(legend) legend.innerHTML = threeVis.mode === 'neural'
    ? '<span><i class="legend-dot entity"></i>Neuron hub</span><span><i class="legend-dot memory"></i>Memory soma</span><span><i class="legend-line"></i>Synapse</span>'
    : threeVis.mode === 'city'
      ? (cityXray ? '<span><i class="legend-dot entity"></i>X-ray district</span><span><i class="legend-dot memory"></i>Glass memory</span><span><i class="legend-line"></i>Scan road</span>' : '<span><i class="legend-dot entity"></i>District landmark</span><span><i class="legend-dot memory"></i>Memory building</span><span><i class="legend-line"></i>Recall road</span>')
      : '<span><i class="legend-dot entity"></i>Entity/topic</span><span><i class="legend-dot memory"></i>Memory</span><span><i class="legend-line"></i>Link</span>';
  const help = $('#threeHelp'); if(help) help.textContent = cityXray ? 'Hologram city: drag to orbit · Shift-drag to pan · pinch to zoom.' : (threeVis.mode === 'city' ? 'Drag to orbit the city · Right-click/Shift+drag to pan · Wheel/pinch to zoom.' : 'Drag to rotate · Right-click/Shift+drag to pan · Wheel/pinch to zoom.');
  const pause = $('#threePause'); if(pause) pause.textContent = threeVis.paused ? (compact ? 'Resume' : (threeVis.mode === 'neural' ? 'Resume drift' : (threeVis.mode === 'city' ? 'Resume traffic' : 'Resume rotation'))) : (compact ? 'Pause' : (threeVis.mode === 'neural' ? 'Pause drift' : (threeVis.mode === 'city' ? 'Pause traffic' : 'Pause rotation')));
  const pan = $('#threePanMode'); if(pan) pan.textContent = threeVis.panMode ? (compact ? 'Orbit' : 'Orbit mode') : (compact ? 'Pan' : 'Pan mode');
}
function threeCameraState(){
  return {
    yaw: threeVis.yaw, pitch: threeVis.pitch, cameraZ: threeVis.cameraZ,
    panX: threeVis.panX, panY: threeVis.panY,
    paused: threeVis.paused, panMode: threeVis.panMode
  };
}
function applyThreeCameraState(viewState){
  if(!viewState) return;
  Object.assign(threeVis, viewState);
  clampThreeCamera();
}
function resetThreeCamera(){ Object.assign(threeVis, { yaw: threeVis.mode === 'neural' ? .12 : (threeVis.mode === 'city' ? .62 : .70), pitch: threeVis.mode === 'neural' ? .10 : (threeVis.mode === 'city' ? .72 : .96), cameraZ: threeVis.mode === 'neural' ? 600 : (threeVis.mode === 'city' ? 1180 : 760), panX:0, panY: threeVis.mode === 'neural' ? -10 : (threeVis.mode === 'city' ? -24 : -84), lastT:0, lastRenderT:0 }); }
function clearThreeScene(){
  if(threeVis.frame) cancelAnimationFrame(threeVis.frame);
  threeVis.frame = 0;
  if(threeVis.renderer){ threeVis.renderer.dispose(); threeVis.renderer.domElement.remove(); }
  $('#threeLabels').innerHTML = '';
  Object.assign(threeVis, { renderer:null, scene:null, camera:null, group:null, nodes:[], edgePairs:[], labels:[], pulses:[] });
}
function cssHexToInt(hex){
  const m = String(hex || '').match(/^#([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : 0xffffff;
}
function colorForTheme(){
  const c = threeVis.mode === 'neural' ? neuralColors() : (threeVis.mode === 'city' ? cityColors() : constellationColors());
  return {
    bg: cssHexToInt(c.bg),
    entity: cssHexToInt(c.star),
    memory: cssHexToInt(c.memory),
    link: cssHexToInt(threeVis.mode === 'neural' ? (c.light ? '#127464' : '#52d6b5') : (threeVis.mode === 'city' ? '#f59e0b' : (c.light ? '#19416c' : '#c6e0ff'))),
    pulse: cssHexToInt(threeVis.mode === 'neural' ? (c.light ? '#6f6048' : '#fffaf0') : (threeVis.mode === 'city' ? '#fff7ad' : c.memory)),
    text: c.text,
    light: c.light
  };
}
function threeRenderPixelRatio(viewport){
  const rect = viewport?.getBoundingClientRect?.() || {width:650,height:650};
  const base = Math.max(1, window.devicePixelRatio || 1);
  const fullscreen = document.fullscreenElement === viewport || viewport?.matches?.(':fullscreen');
  const mobile = rect.width < 520;
  if(threeVis.mode === 'city'){
    const cityCap = fullscreen ? 1.8 : (mobile ? 1.35 : 1.45);
    return Math.max(1, Math.min(base, cityCap));
  }
  const qualityBoost = fullscreen ? 1.45 : 1.35;
  const cap = fullscreen ? 3.5 : (mobile ? 2.75 : 3.25);
  const maxPixels = fullscreen ? 12000000 : (mobile ? 3000000 : 6500000);
  const areaCap = Math.sqrt(maxPixels / Math.max(1, rect.width * rect.height));
  return Math.max(1, Math.min(base * qualityBoost, cap, areaCap));
}
function visualGroupForNode(n, mode=threeVis.mode){
  if(mode === 'city') return n.layout_district || n.layout_region || n.category || 'Other';
  if(mode === 'neural') return n.layout_region || n.category || 'Other';
  return n.layout_region || n.category || 'Other';
}
function semanticGroupForNode(n){ return n.semantic_category || n.category || 'Other'; }
function replayStateForNode(n){
  if(!threeVis.replayNodes || !n) return null;
  const rid = String(n.memory_id || '').trim();
  if(rid && threeVis.replayNodes.has(rid)) return 'included';
  if(n.kind !== 'memory' && threeVis.replayEntities?.has(String(n.label || '').toLowerCase())) return 'candidate';
  return null;
}
function healthStateForNode(n){ return n?.health?.state || 'steady'; }
function resultRid(r){ return String(r?.rid || r?.memory_id || r?.id || '').trim(); }
function resultText(r){ return String(r?.text || r?.preview || r?.content || '').replace(/\s+/g,' ').trim(); }
function buildRecallOverlayData(data, results=[]){
  if(!results.length) return data;
  const copy = {...data};
  const baseNodes = (data.nodes || []).map(n => ({...n}));
  const baseEdges = (data.edges || []).map(e => ({...e}));
  const byRid = new Map(baseNodes.filter(n => n.memory_id).map(n => [String(n.memory_id), n]));
  const hubId = 'replay:hub';
  const hub = { id:hubId, label:'Recall replay', kind:'entity', category:'Recall replay', semantic_category:'Recall replay', layout_region:'Recall replay', layout_district:'Recall replay', weight:9, count:results.length, replay_hub:true };
  const overlayNodes = [hub];
  const overlayEdges = [];
  const added = new Set();
  results.forEach((r,i) => {
    const rid = resultRid(r); if(!rid || added.has(rid)) return; added.add(rid);
    const existing = byRid.get(rid);
    if(existing){ existing.replay_boost = true; existing.layout_region = existing.layout_region || 'Recall replay'; existing.layout_district = existing.layout_district || existing.layout_region || 'Recall replay'; overlayEdges.push({ id:`replay-edge:${rid}`, source:hubId, target:existing.id, label:'recalled', kind:'replay', item:{rid, namespace:existing.namespace || r.namespace} }); return; }
    const text = resultText(r);
    const domain = String(r.domain || 'Recall replay');
    const node = {
      id:`replay:${rid}`, label:`memory:${rid.slice(0,8)}`, kind:'memory', category:'Recall replay', semantic_category:domain,
      layout_region:'Recall replay', layout_district:`Recall replay / ${domain}`, namespace:r.namespace || ns(), scope_label:r.namespace || ns(),
      weight:Math.max(7.5, Number(r.importance || r.score || .7) * 10), count:1, memory_id:rid, preview:text || `Recall result ${i+1}`,
      health:{state:'recalled', tags:['recalled','injected'], access_count:Number(r.access_count || 0), age_days:null}, replay_boost:true
    };
    overlayNodes.push(node);
    overlayEdges.push({ id:`replay-edge:${rid}`, source:hubId, target:node.id, label:'recalled', kind:'replay', item:{rid, namespace:r.namespace || ns()} });
  });
  const recalled = new Set(results.map(resultRid).filter(Boolean));
  const sortedBase = baseNodes.sort((a,b)=>(recalled.has(String(b.memory_id||''))?1:0)-(recalled.has(String(a.memory_id||''))?1:0));
  copy.nodes = [...overlayNodes, ...sortedBase];
  copy.edges = [...overlayEdges, ...baseEdges];
  copy.clusters = [{label:'Recall replay', count:results.length}, ...(data.clusters || [])];
  copy.replay_overlay = true;
  return copy;
}

function makePointTexture(THREE, kind){
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.scale(2,2);
  const cx=64, cy=64;
  if(kind === 'star'){
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,60);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.28,'rgba(255,255,255,.92)');
    g.addColorStop(.58,'rgba(255,255,255,.38)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,60,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.72)'; ctx.lineWidth=1.3;
    ctx.beginPath(); ctx.moveTo(cx,14); ctx.lineTo(cx,114); ctx.moveTo(14,cy); ctx.lineTo(114,cy); ctx.stroke();
  } else if(kind === 'neuron') {
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,62);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.13,'rgba(255,255,255,.94)');
    g.addColorStop(.42,'rgba(255,255,255,.28)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,61,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.70)'; ctx.lineCap='round'; ctx.lineJoin='round';
    for(let i=0;i<9;i++){
      const a=(i/9)*Math.PI*2 + .13;
      const len=22 + (i%4)*4;
      const fork=len*.62;
      const sx=cx+Math.cos(a)*13, sy=cy+Math.sin(a)*13;
      const mx=cx+Math.cos(a+.10*Math.sin(i))*fork, my=cy+Math.sin(a+.10*Math.sin(i))*fork;
      const ex=cx+Math.cos(a)*len, ey=cy+Math.sin(a)*len;
      ctx.lineWidth=i%3===0?2.25:1.45;
      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.quadraticCurveTo(mx,my,ex,ey); ctx.stroke();
      ctx.lineWidth=.9;
      ctx.globalAlpha=.72;
      ctx.beginPath(); ctx.moveTo(mx,my); ctx.lineTo(cx+Math.cos(a+.38)*len*.66,cy+Math.sin(a+.38)*len*.66); ctx.stroke();
      if(i%3===0){ ctx.beginPath(); ctx.moveTo(mx,my); ctx.lineTo(cx+Math.cos(a-.34)*len*.60,cy+Math.sin(a-.34)*len*.60); ctx.stroke(); }
      ctx.globalAlpha=1;
    }
    ctx.fillStyle='rgba(255,255,255,.98)'; ctx.beginPath(); ctx.arc(cx,cy,34,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.54)'; ctx.beginPath(); ctx.arc(cx-8,cy-9,8,0,Math.PI*2); ctx.fill();
  } else if(kind === 'soma') {
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,62);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.18,'rgba(255,255,255,.96)');
    g.addColorStop(.42,'rgba(255,255,255,.34)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,62,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.68)'; ctx.lineCap='round'; ctx.lineWidth=1.55;
    for(let i=0;i<5;i++){
      const a=(i/5)*Math.PI*2+.22, len=21+(i%2)*4;
      ctx.beginPath(); ctx.moveTo(cx+Math.cos(a)*18,cy+Math.sin(a)*18); ctx.lineTo(cx+Math.cos(a)*len,cy+Math.sin(a)*len); ctx.stroke();
    }
    ctx.lineWidth=3.4; ctx.beginPath(); ctx.arc(cx,cy,40,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,1)'; ctx.beginPath(); ctx.arc(cx,cy,35,0,Math.PI*2); ctx.fill();
  } else {
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,60);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.44,'rgba(255,255,255,.82)');
    g.addColorStop(.78,'rgba(255,255,255,.22)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,60,0,Math.PI*2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
function buildThreePositions(data){
  if(threeVis.mode === 'neural') return buildThreeNeuralPositions(data);
  if(threeVis.mode === 'city') return buildThreeCityPositions(data);
  const nodes = (data.nodes || []).slice(0,160).map(n => ({...n}));
  const categories = [...new Set(nodes.map(n => visualGroupForNode(n, 'constellation')))];
  const catIndex = Object.fromEntries(categories.map((c,i)=>[c,i]));
  nodes.forEach((n,i) => {
    const cat = visualGroupForNode(n, 'constellation');
    const ci = catIndex[cat] || 0;
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const shell = n.kind === 'memory' ? 1.12 : .74 + (ci % 3) * .10;
    const radius = 285 * shell + (i % 7) * 18 + Math.min(46, Math.sqrt(weight) * 5.5);
    const longitude = ((i * 137.508 + ci * 23) % 360) * Math.PI / 180;
    const latitudeSeed = (((i * 53 + ci * 29) % 101) + .5) / 101;
    const latitude = Math.acos(1 - 2 * latitudeSeed) - Math.PI / 2;
    const radial = Math.cos(latitude);
    const orbitBias = Math.sin((i / Math.max(nodes.length,1)) * Math.PI * 2 + ci * .62) * 22;
    n.x = Math.cos(longitude) * radial * radius;
    n.y = Math.sin(latitude) * radius * .92 + orbitBias;
    n.z = Math.sin(longitude) * radial * radius * 1.12 + Math.cos(longitude * 1.7 + ci) * 54;
    const sizeJitter = 1 + (((i * 37) % 11) - 5) * .035;
    n.size = Math.min(42, 9 + Math.sqrt(weight)*6.2 + (n.kind === 'memory' ? 3.5 : 4.5)) * sizeJitter;
    n.twinkle = (i % 23) / 23;
    const twinkleTier = i % 17 === 0 ? 2 : (i % 5 === 0 ? 1 : 0);
    n.twinkleFreq = twinkleTier === 2 ? .0048 + ((i * 41) % 130) / 100000 : (twinkleTier === 1 ? .0024 + ((i * 47) % 120) / 100000 : .00125 + ((i * 53) % 110) / 100000);
    n.twinkleAmp = twinkleTier === 2 ? .34 : (twinkleTier === 1 ? .24 : .15 + ((i * 29) % 70) / 1000);
    n._degree = 0; n._weight = weight; n.visualGroup = cat;
  });
  return nodes;
}
function buildThreeNeuralPositions(data){
  const nodes = (data.nodes || []).slice(0,170).map(n => ({...n}));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = (data.edges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target)).slice(0,340);
  const categories = [...new Set(nodes.map(n => visualGroupForNode(n, 'neural')))];
  const catIndex = Object.fromEntries(categories.map((c,i)=>[c,i]));
  const regionCount = Math.max(1, categories.length);
  const regions = Object.fromEntries(categories.map((cat, i) => {
    const angle = -Math.PI / 2 + (i / regionCount) * Math.PI * 2;
    const radius = regionCount <= 2 ? 86 : (i === regionCount - 1 && regionCount > 5 ? 70 : 142 + (i % 2) * 18);
    const lap = Math.floor(i / Math.max(1, regionCount));
    return [cat, {
      label:cat,
      angle,
      cx:Math.cos(angle) * radius + lap * 18,
      cy:Math.sin(angle) * radius * .96,
      cz:((i * 41) % 89 - 44) * .72,
      spread:94 + (i % 4) * 10
    }];
  }));
  const degree = new Map();
  edges.forEach(e => { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); });
  const hubsByCategory = {};
  nodes.filter(n => n.kind !== 'memory').sort((a,b)=>(Number(b.weight || b.count || 0)+ (degree.get(b.id)||0)) - (Number(a.weight || a.count || 0)+(degree.get(a.id)||0))).forEach(n => {
    const cat = visualGroupForNode(n, 'neural'); if(!hubsByCategory[cat]) hubsByCategory[cat] = []; hubsByCategory[cat].push(n);
  });
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  nodes.forEach((n,i) => {
    const cat = visualGroupForNode(n, 'neural');
    const region = regions[cat] || regions.Other || { cx:0, cy:0, cz:0, angle:0, spread:80 };
    const ci = catIndex[cat] || 0;
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const d = degree.get(n.id) || 0;
    if(n.kind === 'memory'){
      const linked = edges.find(e => e.source === n.id || e.target === n.id);
      const parent = linked ? byId[linked.source === n.id ? linked.target : linked.source] : null;
      const parentX = parent && parent.kind !== 'memory' && Number.isFinite(parent.x) ? parent.x : region.cx;
      const parentY = parent && parent.kind !== 'memory' && Number.isFinite(parent.y) ? parent.y : region.cy;
      const parentZ = parent && parent.kind !== 'memory' && Number.isFinite(parent.z) ? parent.z : region.cz;
      const branch = ((i * 137.508 + ci * 19) % 360) * Math.PI / 180;
      const yUnit = ((((i * 43 + ci * 17) % 97) + .5) / 97) * 2 - 1;
      const radial = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
      const dist = 46 + (i % 6) * 13 + Math.min(48, Math.sqrt(weight) * 10);
      n.x = parentX + Math.cos(branch) * radial * dist;
      n.y = parentY + yUnit * dist * .82;
      n.z = parentZ + Math.sin(branch) * radial * dist * .86;
    } else {
      const rank = Math.max(0, (hubsByCategory[cat] || []).indexOf(n));
      const orbit = rank === 0 ? 0 : 30 + Math.sqrt(rank) * 20;
      const angle = region.angle + rank * 2.399963 + (ci % 3) * .24;
      const yUnit = rank === 0 ? 0 : ((((rank * 37 + ci * 11) % 89) + .5) / 89) * 2 - 1;
      const radial = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
      n.x = region.cx + Math.cos(angle) * radial * orbit;
      n.y = region.cy + yUnit * orbit * .86;
      n.z = region.cz + Math.sin(angle) * radial * orbit * .80;
    }
    n.size = Math.min(30, 8 + Math.sqrt(weight + d) * (n.kind === 'memory' ? 3.2 : 4.1));
    n._degree = d; n._weight = weight; n.neuralRegion = cat;
  });
  threeVis.neuralRegions = Object.values(regions);
  return nodes;
}
function buildThreeCityPositions(data){
  const nodes = (data.nodes || []).slice(0,190).map(n => ({...n}));
  const categories = [...new Set(nodes.map(n => visualGroupForNode(n, 'city')))];
  const cols = Math.ceil(Math.sqrt(Math.max(1, categories.length)));
  const districtSize = 210;
  const districts = Object.fromEntries(categories.map((cat, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return [cat, {
      label: cat,
      cx: (col - (cols - 1) / 2) * districtSize,
      cz: (row - Math.floor((categories.length - 1) / cols) / 2) * districtSize,
      index: i,
      count: nodes.filter(n => (n.category || 'Other') === cat).length,
    }];
  }));
  const byCategoryRank = {};
  nodes.forEach(n => { const cat=visualGroupForNode(n, 'city'); if(!byCategoryRank[cat]) byCategoryRank[cat]=0; });
  nodes.forEach((n, i) => {
    const cat = visualGroupForNode(n, 'city');
    const district = districts[cat] || {cx:0,cz:0,index:0};
    const rank = byCategoryRank[cat]++;
    const memory = n.kind === 'memory';
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const grid = Math.ceil(Math.sqrt(Math.max(1, (district.count || 1))));
    const gx = rank % grid;
    const gz = Math.floor(rank / grid);
    const spacing = memory ? 24 : 32;
    const jitterX = (((i * 37) % 17) - 8) * .8;
    const jitterZ = (((i * 53) % 19) - 9) * .75;
    n.cityHeight = memory ? Math.min(96, 16 + Math.sqrt(weight) * 18 + Number(n.count || 0) * .9) : Math.min(132, 34 + Math.sqrt(weight) * 22);
    n.cityWidth = memory ? 15 + (i % 4) * 3 : 24 + (i % 3) * 5;
    n.cityDepth = memory ? 16 + (i % 5) * 2 : 24 + (i % 4) * 4;
    n.x = district.cx + (gx - (grid - 1) / 2) * spacing + jitterX;
    n.z = district.cz + (gz - (grid - 1) / 2) * spacing + jitterZ;
    n.y = n.cityHeight / 2;
    n.size = Math.max(15, Math.min(44, n.cityWidth + Math.sqrt(weight) * 4));
    n._degree = 0; n._weight = weight; n.cityDistrict = cat;
  });
  threeVis.cityDistricts = Object.values(districts);
  return nodes;
}
function addMemoryCity(THREE, group, nodes, edges, colors, xray=false){
  const districtGeom = new THREE.PlaneGeometry(172, 172, 1, 1);
  const districtMats = [
    new THREE.MeshBasicMaterial({ color:0x11121b, transparent:true, opacity:xray ? .28 : .62, side:THREE.DoubleSide, depthWrite:false }),
    new THREE.MeshBasicMaterial({ color:0x101827, transparent:true, opacity:xray ? .28 : .62, side:THREE.DoubleSide, depthWrite:false })
  ];
  const districtRingMat = new THREE.LineBasicMaterial({ color:colors.link, transparent:true, opacity:xray ? .22 : .18, depthWrite:false });
  const districtEdgeGeom = new THREE.EdgesGeometry(districtGeom);
  (threeVis.cityDistricts || []).forEach((d, i) => {
    const plane = new THREE.Mesh(districtGeom, districtMats[i % 2]);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(d.cx, -1.2, d.cz);
    group.add(plane);
    const ring = new THREE.LineSegments(districtEdgeGeom, districtRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(plane.position);
    group.add(ring);
  });
  const roadPositions=[];
  edges.forEach(e => { roadPositions.push(e.a.x, 1.2, e.a.z, e.b.x, 1.2, e.b.z); });
  if(roadPositions.length){
    const roadGeom = new THREE.BufferGeometry(); roadGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(roadPositions),3));
    group.add(new THREE.LineSegments(roadGeom, new THREE.LineBasicMaterial({ color:colors.link, transparent:true, opacity:xray ? .28 : .14, depthWrite:false })));
  }
  const boxGeom = new THREE.BoxGeometry(1, 1, 1);
  const sphereGeom = new THREE.SphereGeometry(3.6, 8, 8);
  const mats = new Map();
  const wireMats = new Map();
  const beaconMats = new Map();
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const materialFor = (key, color, opacity) => {
    const id = `${key}:${color}:${opacity.toFixed(2)}`;
    if(!mats.has(id)) mats.set(id, new THREE.MeshBasicMaterial({ color, transparent:true, opacity, depthWrite:!xray }));
    return mats.get(id);
  };
  const wireMatFor = (key, opacity) => {
    const id = `${key}:${opacity.toFixed(2)}`;
    if(!wireMats.has(id)) wireMats.set(id, new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity, wireframe:true, depthWrite:false }));
    return wireMats.get(id);
  };
  const beaconMatFor = color => {
    if(!beaconMats.has(color)) beaconMats.set(color, new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.88, depthWrite:false }));
    return beaconMats.get(color);
  };
  const pushBucket = (map, material, node) => {
    const key = material.uuid;
    if(!map.has(key)) map.set(key, { material, nodes:[] });
    map.get(key).nodes.push(node);
  };
  const buildingBuckets = new Map();
  const wireBuckets = new Map();
  const outlineLimit = xray ? 72 : 54;
  let outlines = 0;
  nodes.forEach((n,i) => {
    const memory = n.kind === 'memory';
    const replay = replayStateForNode(n);
    const health = healthStateForNode(n);
    let baseColor = memory ? colors.memory : colors.entity;
    if(memory && health === 'stale') baseColor = 0x64748b;
    if(memory && health === 'low-signal') baseColor = 0x475569;
    if(memory && health === 'important') baseColor = 0xa7f3d0;
    if(memory && health === 'recalled') baseColor = 0xffffff;
    if(replay === 'included') baseColor = 0xffffff;
    const cityOpacity = memory ? (health === 'stale' ? (xray ? .20 : .48) : (xray ? .34 : .78)) : (xray ? .30 : .88);
    pushBucket(buildingBuckets, materialFor(`${memory?'mem':'entity'}:${health}:${replay||''}`, baseColor, cityOpacity), n);
    const important = replay === 'included' || !memory || Number(n._weight || 0) > 4.6 || health !== 'steady';
    if(important && outlines < outlineLimit){
      outlines++;
      pushBucket(wireBuckets, wireMatFor(memory ? 'memory' : 'entity', xray ? (memory ? .36 : .46) : (memory ? .13 : .20)), n);
    }
    if(memory && ['stale','low-signal','busy','important','recalled'].includes(health)){
      const beaconColor = health === 'stale' ? 0xf97316 : (health === 'low-signal' ? 0x94a3b8 : (health === 'busy' ? 0x38bdf8 : 0x34d399));
      const beacon = new THREE.Mesh(sphereGeom, beaconMatFor(beaconColor));
      beacon.position.set(n.x, (n.cityHeight || 34) + 8, n.z);
      group.add(beacon);
    }
  });
  const addInstancedBoxes = (bucketMap) => {
    bucketMap.forEach(({material, nodes:bucketNodes}) => {
      const instanced = new THREE.InstancedMesh(boxGeom, material, bucketNodes.length);
      bucketNodes.forEach((n, idx) => {
        matrix.compose(
          new THREE.Vector3(n.x, n.y, n.z),
          quat,
          new THREE.Vector3(n.cityWidth || 18, n.cityHeight || 34, n.cityDepth || 18)
        );
        instanced.setMatrixAt(idx, matrix);
      });
      instanced.instanceMatrix.needsUpdate = true;
      group.add(instanced);
    });
  };
  addInstancedBoxes(buildingBuckets);
  addInstancedBoxes(wireBuckets);
}
function limitedThreeEdges(data, byId, mobile=false){
  const degree = new Map(); const out=[];
  const limit = threeVis.mode === 'neural' ? 132 : (threeVis.mode === 'city' ? (mobile ? 72 : 110) : (mobile ? 92 : 140));
  const degreeLimit = threeVis.mode === 'neural' ? 5 : (threeVis.mode === 'city' ? 3 : (mobile ? 3 : 4));
  for(const e of (data.edges || [])){
    const a=byId.get(e.source), b=byId.get(e.target); if(!a || !b) continue;
    const da=degree.get(e.source)||0, db=degree.get(e.target)||0; if(da>=degreeLimit || db>=degreeLimit) continue;
    degree.set(e.source, da+1); degree.set(e.target, db+1); a._degree++; b._degree++; out.push({ ...e, a, b });
    if(out.length >= limit) break;
  }
  return out;
}
function neuralAuraOverlay(regions){
  if(threeVis.mode !== 'neural') return '';
  const regionList = (regions || []).slice(0,9);
  return `<div class="three-aura-layer">${regionList.map((r,i)=>`<span class="three-aura-oval" data-region="${esc(r.label || '')}" style="opacity:0;transform:translate(-50%,-50%) rotate(${(Number(r.angle || 0) * 28).toFixed(1)}deg)"></span>`).join('')}</div>`;
}
function makeAuraOvalTexture(THREE){
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 640;
  const ctx = canvas.getContext('2d'); ctx.scale(2,2); const cx=256, cy=160;
  const g = ctx.createRadialGradient(cx, cy, 12, cx, cy, 230);
  g.addColorStop(0, 'rgba(102,232,198,.24)');
  g.addColorStop(.52, 'rgba(102,232,198,.13)');
  g.addColorStop(1, 'rgba(102,232,198,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(cx, cy, 238, 142, 0, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle='rgba(102,232,198,.16)'; ctx.lineWidth=2;
  for(let i=0;i<3;i++){
    ctx.beginPath(); ctx.ellipse(cx, cy, 88+i*48, 46+i*28, 0, 0, Math.PI*2); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas); tex.needsUpdate = true; return tex;
}
function addNeuralAuraOvals(THREE, group, regions, colors){
  const texture = makeAuraOvalTexture(THREE);
  (regions || []).slice(0,10).forEach((region, i) => {
    const material = new THREE.SpriteMaterial({ map:texture, color:colors.entity, transparent:true, opacity:colors.light ? .13 : .18, depthWrite:false, depthTest:false, blending:THREE.AdditiveBlending, rotation:(region.angle || 0) * .42 });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(region.cx || 0, region.cy || 0, (region.cz || 0) - 18 - i*.8);
    const spread = region.spread || 86;
    sprite.scale.set(spread * (3.9 + (i%3)*.35), spread * (2.35 + (i%2)*.22), 1);
    sprite.renderOrder = -10 + i;
    group.add(sprite);
  });
}
function addHaloPoints(THREE, scene, nodes, kind, color, size){
  let selected = nodes.filter(n => (n.kind === 'memory') === (kind === 'memory'));
  if(threeVis.mode !== 'neural'){
    selected = selected
      .filter(n => {
        const weight = Math.max(1, Number(n.weight || n.count || 1));
        return weight > (kind === 'memory' ? 3.6 : 4.4) || Number(n._degree || 0) > 3;
      })
      .sort((a,b)=>(Math.max(1, Number(b.weight || b.count || 1)) + Number(b._degree || 0)) - (Math.max(1, Number(a.weight || a.count || 1)) + Number(a._degree || 0)))
      .slice(0, kind === 'memory' ? 30 : 44);
  }
  const positions = new Float32Array(selected.length * 3);
  selected.forEach((n,i)=>{ positions[i*3]=n.x; positions[i*3+1]=n.y; positions[i*3+2]=n.z; });
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  const themeColors = colorForTheme();
  const isNeural = threeVis.mode === 'neural';
  const opacity = isNeural
    ? (kind === 'memory' ? (themeColors.light ? .16 : .28) : (themeColors.light ? .18 : .34))
    : (kind === 'memory' ? (themeColors.light ? .12 : .24) : (themeColors.light ? .13 : .26));
  const material = new THREE.PointsMaterial({ color, map:makePointTexture(THREE, 'orb'), alphaTest:.015, size, sizeAttenuation:true, transparent:true, opacity, depthWrite:false, blending:themeColors.light ? THREE.NormalBlending : THREE.AdditiveBlending });
  const points = new THREE.Points(geometry, material); scene.add(points); return points;
}
function addReplayBeacons(THREE, group, nodes, colors){
  const recalled = nodes.filter(n => replayStateForNode(n) === 'included').slice(0, 18);
  if(!recalled.length) return;
  if(threeVis.mode === 'city'){
    recalled.forEach((n,i) => {
      const h = Math.max(72, (n.cityHeight || 34) + 64);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(7.5, 13, h, 18, 1, true),
        new THREE.MeshBasicMaterial({ color:0x67e8f9, transparent:true, opacity:.30, depthWrite:false, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending, side:THREE.DoubleSide })
      );
      beam.position.set(n.x, h / 2, n.z);
      group.add(beam);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(Math.max(18, (n.cityWidth || 18) * 1.25), 2.8, 8, 36),
        new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:.84, depthWrite:false, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(n.x, 3 + (i % 3) * .8, n.z);
      group.add(ring);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(7.5, 18, 18), new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:.96, depthWrite:false }));
      crown.position.set(n.x, (n.cityHeight || 34) + 16, n.z);
      group.add(crown);
    });
    return;
  }
  const positions = new Float32Array(recalled.length * 3);
  recalled.forEach((n,i)=>{ positions[i*3]=n.x; positions[i*3+1]=n.y; positions[i*3+2]=n.z; });
  const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(positions,3));
  const marker = new THREE.Points(geom, new THREE.PointsMaterial({ color:0xffffff, map:makePointTexture(THREE, 'star'), alphaTest:.02, size:threeVis.mode === 'neural' ? 82 : 96, sizeAttenuation:true, transparent:true, opacity:.96, depthWrite:false, depthTest:false, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending }));
  marker.renderOrder = 50;
  group.add(marker);
  recalled.slice(0,8).forEach(n => {
    const light = new THREE.PointLight(0x67e8f9, threeVis.mode === 'neural' ? 1.5 : 1.2, 180);
    light.position.set(n.x, n.y, n.z);
    group.add(light);
  });
}
function addNeuralDendrites(THREE, group, nodes, colors){
  const trunks=[]; const twigs=[]; const tips=[];
  nodes.slice(0,150).forEach((n,i)=>{
    const arms = n.kind === 'memory' ? 3 : 6;
    const base = n.kind === 'memory' ? 10 : 17;
    for(let a=0;a<arms;a++){
      const theta=(a/arms)*Math.PI*2 + (i%11)*.19;
      const phi=Math.sin(i*.37+a)*.58;
      const len=base + ((i+a*13)%9);
      const mid=[n.x+Math.cos(theta+.16)*Math.cos(phi)*len*.50, n.y+Math.sin(phi)*len*.36, n.z+Math.sin(theta+.16)*Math.cos(phi)*len*.50];
      const end=[n.x+Math.cos(theta)*Math.cos(phi)*len*.78, n.y+Math.sin(phi)*len*.54, n.z+Math.sin(theta)*Math.cos(phi)*len*.78];
      trunks.push(n.x,n.y,n.z, mid[0],mid[1],mid[2], mid[0],mid[1],mid[2], end[0],end[1],end[2]);
      if(n.kind !== 'memory' && a%2===0){
        const side=theta+(a%2?.44:-.40);
        const fork=[mid[0]+Math.cos(side)*len*.18, mid[1]+Math.sin(phi+.25)*len*.12, mid[2]+Math.sin(side)*len*.18];
        twigs.push(mid[0],mid[1],mid[2], fork[0],fork[1],fork[2]);
      }
      if(i%3===0 && a%2===0) tips.push(end[0],end[1],end[2]);
    }
  });
  const trunkGeom = new THREE.BufferGeometry(); trunkGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(trunks),3));
  group.add(new THREE.LineSegments(trunkGeom, new THREE.LineBasicMaterial({ color:colors.entity, transparent:true, opacity:colors.light ? .34 : .36, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite:false })));
  const twigGeom = new THREE.BufferGeometry(); twigGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(twigs),3));
  group.add(new THREE.LineSegments(twigGeom, new THREE.LineBasicMaterial({ color:colors.link, transparent:true, opacity:colors.light ? .28 : .24, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite:false })));
  const tipGeom = new THREE.BufferGeometry(); tipGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tips),3));
  group.add(new THREE.Points(tipGeom, new THREE.PointsMaterial({ color:colors.entity, map:makePointTexture(THREE, 'orb'), alphaTest:.03, size:3.8, transparent:true, opacity:colors.light ? .54 : .72, depthWrite:false, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending })));
}
function addPoints(THREE, scene, nodes, kind, color, size){
  const selected = nodes.filter(n => (n.kind === 'memory') === (kind === 'memory'));
  const positions = new Float32Array(selected.length * 3);
  const sizes = new Float32Array(selected.length);
  const phases = new Float32Array(selected.length);
  const freqs = new Float32Array(selected.length);
  const amps = new Float32Array(selected.length);
  const majors = new Float32Array(selected.length);
  selected.forEach((n,i)=>{
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    positions[i*3]=n.x; positions[i*3+1]=n.y; positions[i*3+2]=n.z;
    const replay = replayStateForNode(n);
    const degreeBoost = Math.min(10, Number(n._degree || 0) * 1.9);
    const variedSize = (n.size || size) + degreeBoost;
    sizes[i]=replay === 'included' ? Math.max(size * 2.8, Math.min(size * 4.4, variedSize * 3.4)) : Math.max(size * 1.14, Math.min(size * 2.65, variedSize * 1.62));
    phases[i]=(n.twinkle || 0) * Math.PI * 2;
    freqs[i]=replay === 'included' ? .012 : (n.twinkleFreq || .0012);
    amps[i]=replay === 'included' ? .62 : (n.twinkleAmp || .12);
    majors[i]=replay === 'included' || weight > 6.2 || (kind === 'memory' && weight > 4.8) ? 1 : 0;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes,1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases,1));
  geometry.setAttribute('aFreq', new THREE.BufferAttribute(freqs,1));
  geometry.setAttribute('aAmp', new THREE.BufferAttribute(amps,1));
  geometry.setAttribute('aMajor', new THREE.BufferAttribute(majors,1));
  const themeColors = colorForTheme();
  let material;
  if(threeVis.mode === 'neural'){
    material = new THREE.PointsMaterial({ color, map:makePointTexture(THREE, kind === 'memory' ? 'soma' : 'neuron'), alphaTest:.04, size, sizeAttenuation:true, transparent:true, opacity:kind === 'memory' ? (themeColors.light ? .88 : .98) : (themeColors.light ? .76 : .86), depthWrite:false, blending:themeColors.light ? THREE.NormalBlending : THREE.AdditiveBlending });
  } else {
    material = new THREE.ShaderMaterial({
      uniforms:{
        uTime:{value:0},
        uScale:{value:420},
        uColor:{value:new THREE.Color(color)},
        uIsStar:{value:kind === 'memory' ? 0 : 1},
        uOpacity:{value:kind === 'memory' ? .98 : .96}
      },
      vertexShader:`
        attribute float aSize;
        attribute float aPhase;
        attribute float aFreq;
        attribute float aAmp;
        attribute float aMajor;
        uniform float uTime;
        uniform float uScale;
        varying float vPulse;
        varying float vMajor;
        void main(){
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float wave = sin(uTime * aFreq + aPhase) + sin(uTime * aFreq * 0.43 + aPhase * 1.71) * 0.45;
          vPulse = 1.0 + wave * aAmp;
          vMajor = aMajor;
          gl_PointSize = aSize * (0.98 + (vPulse - 1.0) * 0.32) * (uScale / max(72.0, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader:`
        uniform vec3 uColor;
        uniform float uIsStar;
        uniform float uOpacity;
        varying float vPulse;
        varying float vMajor;
        void main(){
          vec2 p = gl_PointCoord - vec2(0.5);
          float d = length(p);
          if(d > 0.5) discard;
          float core = 1.0 - smoothstep(0.026, 0.060, d);
          float body = 1.0 - smoothstep(0.060, 0.135, d);
          float halo = (1.0 - smoothstep(0.13, 0.48, d)) * (0.15 + clamp(vPulse - 1.0, -0.30, 0.46) * 0.82);
          float rayH = max(0.0, 1.0 - abs(p.y) / 0.010) * (1.0 - smoothstep(0.07, 0.44, abs(p.x)));
          float rayV = max(0.0, 1.0 - abs(p.x) / 0.010) * (1.0 - smoothstep(0.07, 0.44, abs(p.y)));
          float diag1 = max(0.0, 1.0 - abs(p.x - p.y) / 0.013) * (1.0 - smoothstep(0.06, 0.26, d));
          float diag2 = max(0.0, 1.0 - abs(p.x + p.y) / 0.013) * (1.0 - smoothstep(0.06, 0.26, d));
          float rays = vMajor * (max(rayH, rayV) * 0.50 + max(diag1, diag2) * 0.16);
          float alpha = (body * 0.46 + core * 1.02 + halo + rays) * uOpacity * clamp(0.72 + (vPulse - 1.0) * 0.92, 0.46, 1.35);
          if(alpha < 0.022) discard;
          vec3 starCore = mix(uColor, vec3(1.0), core * 0.88 + rays * 0.38);
          vec3 memoryCore = mix(uColor, vec3(1.0), core * 0.34);
          vec3 crisp = mix(memoryCore, starCore, uIsStar);
          gl_FragColor = vec4(crisp * (0.92 + (vPulse - 1.0) * 0.22), min(alpha, 1.0));
        }
      `,
      transparent:true,
      depthWrite:false,
      blending:THREE.NormalBlending
    });
  }
  const points = new THREE.Points(geometry, material); points.userData.nodes = selected; scene.add(points); return points;
}
function buildThreeLinkSegments(THREE, edges){
  const positions = [];
  edges.forEach((e,i)=>{
    if(threeVis.mode === 'neural'){
      const ax=e.a.x, ay=e.a.y, az=e.a.z, bx=e.b.x, by=e.b.y, bz=e.b.z;
      const dx=bx-ax, dy=by-ay, dz=bz-az;
      const len=Math.max(1, Math.hypot(dx,dy,dz));
      const bend=(i%2?1:-1) * Math.min(58, 18 + len*.12);
      const cx=(ax+bx)/2 + (-dy/len)*bend;
      const cy=(ay+by)/2 + (dx/len)*bend*.55 + Math.sin(i*.71)*18;
      const cz=(az+bz)/2 + Math.cos(i*.53)*bend*.72;
      e._curve={cx,cy,cz};
      let px=ax, py=ay, pz=az;
      for(let step=1; step<=7; step++){
        const t=step/7, inv=1-t;
        const x=inv*inv*ax+2*inv*t*cx+t*t*bx;
        const y=inv*inv*ay+2*inv*t*cy+t*t*by;
        const z=inv*inv*az+2*inv*t*cz+t*t*bz;
        positions.push(px,py,pz,x,y,z); px=x; py=y; pz=z;
      }
    } else {
      positions.push(e.a.x,e.a.y,e.a.z,e.b.x,e.b.y,e.b.z);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions),3));
  return geometry;
}
async function renderThreeVisualiser(data, opts={}){
  const preserveView = !!opts.preserveView;
  const viewState = opts.viewState || (preserveView ? threeCameraState() : null);
  const THREE = await loadThreeModule();
  clearThreeScene(); threeVis.data = data; updateThreeUI(); threeInspectorDefault();
  if(!data?.replay_overlay) threeVis.baseData = data;
  const viewport = $('#threeViewport'); if(!viewport) return;
  const colors = colorForTheme();
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'high-performance', precision:'highp', stencil:false });
  } catch(err) {
    $('#threeViewport').classList.add('three-fallback');
    $('#threeLabels').innerHTML = `<div class="three-fallback-card"><h3>3D visualiser unavailable</h3><p>The original Visualiser remains available for this browser.</p></div>`;
    $('#threeInspector').innerHTML = `<div class="inspector-kicker">Constellation inspector</div><h3>3D visualiser unavailable</h3><p class="muted">Try the original Visualiser, or reopen this page in a browser that supports the 3D view.</p>`;
    return;
  }
  $('#threeViewport').classList.remove('three-fallback');
  renderer.setPixelRatio(threeRenderPixelRatio(viewport));
  if('outputColorSpace' in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(colors.bg, 0);
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(colors.bg, threeVis.mode === 'neural' ? .0011 : .0009);
  const mobileThree = (viewport.getBoundingClientRect?.().width || 650) < 520;
  const camera = new THREE.PerspectiveCamera(48, 1, 1, 5000);
  const group = new THREE.Group(); scene.add(group);
  const ambient = new THREE.AmbientLight(0xffffff, .55); scene.add(ambient);
  const light = new THREE.PointLight(colors.entity, 1.2, 1200); light.position.set(180,220,260); scene.add(light);
  const nodes = buildThreePositions(data); const byId = new Map(nodes.map(n=>[n.id,n])); const edges = limitedThreeEdges(data, byId, mobileThree);
  let linkGeom = null;
  const linkMaterial = threeVis.mode === 'neural'
    ? new THREE.LineBasicMaterial({ color:colors.link, transparent:true, opacity:colors.light ? .30 : .40, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite:false })
    : new THREE.LineDashedMaterial({ color:colors.link, transparent:true, opacity:colors.light ? (mobileThree ? .14 : .16) : (mobileThree ? .13 : .12), dashSize:9, gapSize:8, blending:THREE.NormalBlending, depthWrite:false });
  if(threeVis.mode !== 'city'){
    linkGeom = buildThreeLinkSegments(THREE, edges);
    const linkLines = new THREE.LineSegments(linkGeom, linkMaterial);
    if(threeVis.mode !== 'neural') linkLines.computeLineDistances();
    group.add(linkLines);
  }
  if(threeVis.mode === 'city'){
    addMemoryCity(THREE, group, nodes, edges, colors, mobileThree);
  } else if(threeVis.mode === 'neural'){
    addHaloPoints(THREE, group, nodes, 'entity', colors.entity, 50);
    addHaloPoints(THREE, group, nodes, 'memory', colors.memory, 48);
    addNeuralDendrites(THREE, group, nodes, colors);
  } else {
    // Constellation already has per-star shader halos. A separate halo layer made
    // the mobile view read like blurry particles instead of the original star map.
  }
  if(threeVis.mode !== 'city'){
    group.add(addPoints(THREE, group, nodes, 'entity', colors.entity, threeVis.mode === 'neural' ? 30 : 52));
    group.add(addPoints(THREE, group, nodes, 'memory', colors.memory, threeVis.mode === 'neural' ? 26 : 50));
  }
  addReplayBeacons(THREE, group, nodes, colors);
  const starCount = threeVis.mode === 'city' ? 180 : (threeVis.mode === 'neural' ? 360 : 420);
  const starPositions = new Float32Array(starCount*3);
  for(let i=0;i<starCount;i++){ const r=600+((i*37)%480), a=i*2.17, b=((i*53)%180-90)*Math.PI/180; starPositions.set([Math.cos(a)*Math.cos(b)*r, Math.sin(b)*r, Math.sin(a)*Math.cos(b)*r], i*3); }
  const starGeom = new THREE.BufferGeometry(); starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions,3));
  scene.add(new THREE.Points(starGeom, new THREE.PointsMaterial({ color:0xffffff, map:makePointTexture(THREE, 'orb'), alphaTest:.04, size:1.25, transparent:true, opacity:threeVis.mode === 'city' ? .16 : (threeVis.mode === 'neural' ? .38 : .24), depthWrite:false })));
  const replayEdges = threeVis.replayNodes?.size ? edges.filter(e => threeVis.replayEdges?.has(e.id) || threeVis.replayNodes.has(String(e.a.memory_id||'')) || threeVis.replayNodes.has(String(e.b.memory_id||''))) : [];
  const pulseEdges = replayEdges.length ? replayEdges.slice(0, 110) : (threeVis.mode === 'neural' ? edges.slice(0, 90) : (threeVis.mode === 'city' ? edges.slice(0, 80) : []));
  const pulseGeom = new THREE.BufferGeometry(); const pulsePositions = new Float32Array(pulseEdges.length*3); pulseGeom.setAttribute('position', new THREE.BufferAttribute(pulsePositions,3));
  const pulsePoints = new THREE.Points(pulseGeom, new THREE.PointsMaterial({ color:colors.pulse, map:makePointTexture(THREE, 'star'), alphaTest:.03, size:threeVis.mode === 'city' ? 8.5 : (threeVis.mode === 'neural' ? 10.5 : 5.2), transparent:true, opacity:threeVis.mode === 'neural' ? (colors.light ? .54 : .98) : (threeVis.mode === 'city' ? .92 : .85), depthWrite:false, depthTest:false, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending })); group.add(pulsePoints);
  const labelNodes = nodes.filter(n => !/^[a-f0-9]{10,}$/i.test(String(n.label||''))).sort((a,b)=>{
    const ar = replayStateForNode(a) === 'included' ? 10000 : 0;
    const br = replayStateForNode(b) === 'included' ? 10000 : 0;
    return (br + b._degree + b._weight) - (ar + a._degree + a._weight);
  }).slice(0, threeVis.mode === 'city' ? 42 : (threeVis.mode === 'neural' ? 72 : 56));
  $('#threeLabels').innerHTML = neuralAuraOverlay(threeVis.neuralRegions) + labelNodes.map((n,i)=>`<span class="three-label ${n.kind === 'memory' ? 'memory' : ''}" data-i="${i}">${esc(String(n.label||'').replace(/^memory:/,'mem ').slice(0,24))}</span>`).join('');
  Object.assign(threeVis, { THREE, renderer, scene, camera, group, nodes, edgePairs:edges, labels:labelNodes, pulses:pulseEdges, pulsePoints });
  $('#threeClusters').innerHTML = (data.clusters || []).map(c => `<span class="cluster-pill">${esc(c.label)} <strong>${Number(c.count).toLocaleString()}</strong></span>`).join('');
  if(preserveView && viewState) applyThreeCameraState(viewState);
  else resetThreeCamera();
  bindThreeControls(); resizeThree(); animateThree(0);
}
function resizeThree(){
  if(!threeVis.renderer) return;
  const viewport = $('#threeViewport'); const rect = viewport.getBoundingClientRect();
  const w = Math.max(320, rect.width), h = Math.max(320, rect.height);
  threeVis.renderer.setPixelRatio(threeRenderPixelRatio(viewport));
  threeVis.renderer.setSize(w,h,false); threeVis.camera.aspect = w/h; threeVis.camera.updateProjectionMatrix();
}
function threeEffectiveCameraZ(rect){
  const box = rect || $('#threeViewport')?.getBoundingClientRect?.() || {width:650,height:650};
  const fill = visualiserResponsiveFill(box.width, box.height);
  const mobile = box.width < 760 || box.height < 520;
  return threeVis.cameraZ / (mobile ? 1 : fill);
}
function updateThreeAuras(rect, projectVector){
  if(threeVis.mode !== 'neural') return;
  const mobile = rect.width < 520;
  $$('#threeLabels .three-aura-oval').forEach(el => {
    const region = el.dataset.region || '';
    const pts = threeVis.nodes.filter(n => n.neuralRegion === region);
    const screens = [];
    pts.forEach(n => {
      projectVector.set(n.x,n.y,n.z).applyMatrix4(threeVis.group.matrixWorld).project(threeVis.camera);
      if(projectVector.z < 1 && projectVector.z > -1) screens.push({ x:(projectVector.x*.5+.5)*rect.width, y:(-projectVector.y*.5+.5)*rect.height });
    });
    if(screens.length < 2){ el.style.opacity = '0'; return; }
    const xs = screens.map(p=>p.x), ys = screens.map(p=>p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const maxW = mobile ? rect.width * .62 : Math.min(340, rect.width * .34);
    const maxH = mobile ? rect.height * .30 : Math.min(230, rect.height * .26);
    const w = Math.max(mobile ? 92 : 128, Math.min(maxW, (maxX - minX) + (mobile ? 46 : 74)));
    const h = Math.max(mobile ? 58 : 78, Math.min(maxH, (maxY - minY) + (mobile ? 34 : 56)));
    el.style.left = `${cx}px`; el.style.top = `${cy}px`; el.style.width = `${w}px`; el.style.height = `${h}px`; el.style.opacity = screens.length > 4 ? '.42' : '.28';
  });
}
function updateThreeLabels(){
  if(!threeVis.camera || !threeVis.group) return;
  const viewport = $('#threeViewport'); const rect = viewport.getBoundingClientRect(); const v = new threeVis.THREE.Vector3();
  updateThreeAuras(rect, v);
  const labelBoxes = [];
  const effectiveCameraZ = threeEffectiveCameraZ(rect);
  const zoomReveal = threeVis.mode === 'neural' ? Math.max(0, Math.min(1, (900 - effectiveCameraZ) / 420)) : Math.max(0, Math.min(1, (760 - effectiveCameraZ) / 520));
  const maxLabels = threeVis.mode === 'city' ? (rect.width < 520 ? 8 : 16) : (threeVis.mode === 'neural' ? ((rect.width < 520 ? 14 : 24) + Math.round(zoomReveal * (rect.width < 520 ? 14 : 18))) : (rect.width < 520 ? (12 + Math.round(zoomReveal * 12)) : (20 + Math.round(zoomReveal * 18))));
  let shown = 0;
  $$('#threeLabels .three-label').forEach((el,i)=>{
    const n = threeVis.labels[i]; if(!n) return;
    v.set(n.x,n.y,n.z).applyMatrix4(threeVis.group.matrixWorld).project(threeVis.camera);
    const sx = (v.x*.5+.5)*rect.width, sy = (-v.y*.5+.5)*rect.height;
    const edgePad = rect.width < 520 ? 68 : 8;
    const bottomPad = threeVis.mode === 'city' ? (rect.width < 520 ? 96 : 64) : (rect.width < 520 ? 70 : 8);
    const visible = v.z < 1 && v.z > -1 && sx > edgePad && sx < rect.width - edgePad && sy > 8 && sy < rect.height - bottomPad;
    const pulse = threeVis.mode === 'neural' && i > 3 ? Math.sin((threeVis.lastT || 0) * .00032 + i * 1.73) : 1;
    const box = {x:sx-54,y:sy-13,w:108,h:24};
    const collides = labelBoxes.some(b => !(box.x+box.w<b.x || b.x+b.w<box.x || box.y+box.h<b.y || b.y+b.h<box.y));
    const show = visible && shown < maxLabels && !collides && (threeVis.mode !== 'neural' || i <= 3 || pulse > .08);
    el.style.display = show ? '' : 'none';
    if(show){
      shown++; labelBoxes.push(box);
      el.style.left = `${sx}px`; el.style.top = `${sy}px`;
      const depthAlpha = Math.max(.32, Math.min(.86, 1 - Math.abs(v.z)*.35));
      const pulseAlpha = threeVis.mode === 'neural' && i > 3 ? Math.min(.78, .38 + pulse * .36) : depthAlpha;
      el.style.opacity = String(Math.min(depthAlpha, pulseAlpha));
    }
  });
}
function animateThree(t=0){
  if(!threeVis.renderer) return;
  const delta = threeVis.lastT ? Math.min(48, t - threeVis.lastT) : 16; threeVis.lastT = t;
  const cityFrameMs = 1000 / (threeVis.drag ? 30 : 20);
  if(threeVis.mode === 'city' && threeVis.lastRenderT && t - threeVis.lastRenderT < cityFrameMs){
    threeVis.frame = requestAnimationFrame(animateThree);
    return;
  }
  threeVis.lastRenderT = t;
  resizeThree();
  if(!threeVis.paused && !threeVis.drag) threeVis.yaw += delta * (threeVis.mode === 'neural' ? .00009 : (threeVis.mode === 'city' ? .000035 : .000055));
  clampThreeCamera();
  threeVis.group.rotation.y = threeVis.yaw; threeVis.group.rotation.x = threeVis.pitch;
  const viewport = $('#threeViewport'); const rect = viewport?.getBoundingClientRect?.() || {width:650,height:650};
  const effectiveCameraZ = threeEffectiveCameraZ(rect);
  threeVis.camera.position.set(threeVis.panX, threeVis.panY, effectiveCameraZ); threeVis.camera.lookAt(threeVis.panX, threeVis.panY, 0);
  if(threeVis.pulsePoints){
    const attr = threeVis.pulsePoints.geometry.attributes.position; const arr = attr.array;
    threeVis.pulses.forEach((e,i)=>{ const phase=(t*.00030 + (i%17)/17)%1; const inv=1-phase; if(e._curve){ arr[i*3]=inv*inv*e.a.x+2*inv*phase*e._curve.cx+phase*phase*e.b.x; arr[i*3+1]=inv*inv*e.a.y+2*inv*phase*e._curve.cy+phase*phase*e.b.y; arr[i*3+2]=inv*inv*e.a.z+2*inv*phase*e._curve.cz+phase*phase*e.b.z; } else if(threeVis.mode === 'city'){ arr[i*3]=e.a.x+(e.b.x-e.a.x)*phase; arr[i*3+1]=8+Math.sin(phase*Math.PI)*28; arr[i*3+2]=e.a.z+(e.b.z-e.a.z)*phase; } else { arr[i*3]=e.a.x+(e.b.x-e.a.x)*phase; arr[i*3+1]=e.a.y+(e.b.y-e.a.y)*phase; arr[i*3+2]=e.a.z+(e.b.z-e.a.z)*phase; } });
    attr.needsUpdate = true;
  }
  threeVis.scene.traverse(obj => {
    if(obj.isPoints && obj.material?.uniforms?.uTime){
      obj.material.uniforms.uTime.value = t;
      obj.material.uniforms.uScale.value = Math.max(360, Math.min(820, threeVis.renderer.domElement.clientHeight || 420));
    }
  });
  threeVis.renderer.render(threeVis.scene, threeVis.camera); updateThreeLabels();
  threeVis.frame = requestAnimationFrame(animateThree);
}
async function runVisualiserRecall(){
  const input = $('#threeRecallQuery');
  const query = String(input?.value || '').trim();
  if(!query){ toast('Enter a recall query'); return; }
  const viewState = threeCameraState();
  const btn = $('#threeRunRecall'); const old = btn?.textContent;
  try{
    if(btn){ btn.disabled = true; btn.textContent = 'Highlighting…'; }
    const data = await api('/api/recall',{method:'POST',body:JSON.stringify({query,top_k:12,namespace:ns(),include_consolidated:true,expand_entities:true})});
    const results = data.results || data.items || [];
    const rids = new Set(results.map(resultRid).filter(Boolean));
    const terms = new Set();
    results.forEach(r => String([r.domain,r.source,...(r.why_retrieved||r.reasons||[])].join(' ')).toLowerCase().split(/[^a-z0-9_.:-]+/).filter(x=>x.length>3).slice(0,8).forEach(x=>terms.add(x)));
    threeVis.replay = { query, results }; threeVis.replayNodes = rids; threeVis.replayEntities = terms; threeVis.replayEdges = new Set();
    $('#threeReplayStatus').innerHTML = `<strong>${results.length} highlighted</strong><span>${esc(query)}</span>`;
    const baseData = threeVis.baseData || (threeVis.data?.replay_overlay ? null : threeVis.data) || threeVis.data;
    if(baseData) await renderThreeVisualiser(buildRecallOverlayData(baseData, results), {preserveView:true, viewState});
  } catch(e){ toast(e.message); }
  finally{ if(btn){ btn.disabled = false; btn.textContent = old || 'Highlight results'; } }
}

async function loadThreeVisualiser(opts={}){
  setVisualiserLoading(true, 'Building visualiser');
  try{
    await renderThreeVisualiser(await api(`/api/constellation?namespace=${encodeURIComponent(ns())}&limit=320`), opts);
  } finally {
    setVisualiserLoading(false);
  }
}
function switchThreeMode(mode){ threeVis.mode = ['neural','city'].includes(mode) ? mode : 'constellation'; if(threeVis.data) renderThreeVisualiser(threeVis.data); else loadThreeVisualiser(); }
function clampThreeCamera(){
  const viewport = $('#threeViewport'); const rect = viewport?.getBoundingClientRect?.() || {width:650,height:650};
  const fallbackZ = threeVis.mode === 'neural' ? 600 : (threeVis.mode === 'city' ? 1180 : 760);
  const minCameraZ = fallbackZ / 10;
  threeVis.cameraZ = Math.max(minCameraZ, Math.min(1800, Number.isFinite(threeVis.cameraZ) ? threeVis.cameraZ : fallbackZ));
  threeVis.yaw = Number.isFinite(threeVis.yaw) ? threeVis.yaw : 0;
  threeVis.pitch = Math.max(-1.15, Math.min(1.15, Number.isFinite(threeVis.pitch) ? threeVis.pitch : .32));
  const zoomFactor = 900 / Math.max(80, threeVis.cameraZ);
  const panLimitX = Math.max(120, rect.width * (.45 + zoomFactor * .18));
  const panLimitY = Math.max(120, rect.height * (.34 + zoomFactor * .12));
  threeVis.panX = Math.max(-panLimitX, Math.min(panLimitX, Number.isFinite(threeVis.panX) ? threeVis.panX : 0));
  threeVis.panY = Math.max(-panLimitY, Math.min(panLimitY, Number.isFinite(threeVis.panY) ? threeVis.panY : 0));
}
function bindThreeControls(){
  const viewport = $('#threeViewport'); if(!viewport || viewport.dataset.controlsBound === 'true') return; viewport.dataset.controlsBound = 'true';
  const pointers = threeVis.pointer || new Map(); threeVis.pointer = pointers;
  const dist = () => { const ps=[...pointers.values()]; return ps.length < 2 ? 1 : Math.max(1, Math.hypot(ps[0].x-ps[1].x, ps[0].y-ps[1].y)); };
  const center = () => { const ps=[...pointers.values()]; return ps.length < 2 ? {x:0,y:0} : {x:(ps[0].x+ps[1].x)/2, y:(ps[0].y+ps[1].y)/2}; };
  viewport.addEventListener('contextmenu', e=>e.preventDefault());
  viewport.addEventListener('wheel', e=>{ if(e.cancelable) e.preventDefault(); threeVis.cameraZ *= Math.exp(e.deltaY*.001); clampThreeCamera(); }, {passive:false});
  viewport.addEventListener('pointerdown', e=>{
    if(e.cancelable) e.preventDefault();
    try { viewport.setPointerCapture?.(e.pointerId); } catch(_err) {}
    pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if(pointers.size >= 2){ const c=center(); threeVis.drag={mode:'pinch',x:c.x,y:c.y,dist:dist(),cameraZ:threeVis.cameraZ,panX:threeVis.panX,panY:threeVis.panY,moved:false}; }
    else threeVis.drag = {mode:(e.button===2 || threeVis.panMode || e.shiftKey) ? 'pan' : 'drag',x:e.clientX,y:e.clientY,yaw:threeVis.yaw,pitch:threeVis.pitch,panX:threeVis.panX,panY:threeVis.panY,moved:false};
    viewport.style.cursor='grabbing';
  }, {passive:false});
  viewport.addEventListener('pointermove', e=>{
    if(!pointers.has(e.pointerId) || !threeVis.drag) return;
    if(e.cancelable) e.preventDefault();
    pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
    const d=threeVis.drag;
    if(d.mode === 'pinch'){
      if(pointers.size < 2) return;
      const c=center(); const scale=dist()/Math.max(1,d.dist);
      threeVis.cameraZ = d.cameraZ / Math.max(.35, Math.min(2.8, scale));
      threeVis.panX = d.panX - (c.x-d.x)*.72;
      threeVis.panY = d.panY + (c.y-d.y)*.72;
      d.moved = d.moved || Math.abs(c.x-d.x)+Math.abs(c.y-d.y)>3 || Math.abs(scale-1)>.015;
      clampThreeCamera(); return;
    }
    const dx=e.clientX-d.x, dy=e.clientY-d.y; if(Math.abs(dx)+Math.abs(dy)>3) d.moved=true;
    if(d.mode === 'pan'){
      threeVis.panX=d.panX-dx*.7; threeVis.panY=d.panY+dy*.7;
    } else { threeVis.yaw=d.yaw+dx*.006; threeVis.pitch=d.pitch+dy*.004; }
    clampThreeCamera();
  }, {passive:false});
  const end=e=>{
    pointers.delete(e.pointerId);
    if(threeVis.drag?.moved) viewport.dataset.suppressClick='true';
    if(pointers.size === 1){ const p=[...pointers.values()][0]; threeVis.drag={mode:'drag',x:p.x,y:p.y,yaw:threeVis.yaw,pitch:threeVis.pitch,panX:threeVis.panX,panY:threeVis.panY,moved:true}; }
    else { threeVis.drag=null; viewport.style.cursor='grab'; }
  };
  viewport.addEventListener('pointerup', end); viewport.addEventListener('pointercancel', end); viewport.addEventListener('pointerleave', end);
  viewport.addEventListener('click', e=>{ if(e.target.closest('.three-fullscreen-inspector,.fullscreen-exit,.viewport-fullscreen,.constellation-legend')) return; if(viewport.dataset.suppressClick==='true'){ viewport.dataset.suppressClick='false'; return; } pickThreeNode(e); });
}
function pickThreeNode(e){
  if(!threeVis.camera || !threeVis.group) return;
  const rect = $('#threeViewport').getBoundingClientRect(); const mouseX=e.clientX-rect.left, mouseY=e.clientY-rect.top;
  const v = new threeVis.THREE.Vector3(); let best=null, bestD=Infinity;
  for(const n of threeVis.nodes){
    v.set(n.x,n.y,n.z).applyMatrix4(threeVis.group.matrixWorld).project(threeVis.camera);
    if(v.z < -1 || v.z > 1) continue;
    const sx=(v.x*.5+.5)*rect.width, sy=(-v.y*.5+.5)*rect.height; const d=Math.hypot(sx-mouseX, sy-mouseY);
    if(d < bestD && d < 18){ bestD=d; best=n; }
  }
  if(best) inspectThreeNode(best);
}

async function loadVisualiser(force=false){ if(force) clearThreeScene(); await loadThreeVisualiser({preserveView:!force && !!threeVis.data}); }
function stopVisualiser(){ clearThreeScene(); }
function resetVisualiser(){ resetThreeCamera(); updateThreeUI(); }
function setVisualiserMode(mode){ switchThreeMode(mode); }
function bindVisualiserEvents(){ bindThreeControls(); }


init().catch(e=>{console.error(e); toast(e.message);});
