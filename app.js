const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const STATES = ['Neutro','Calmo','Focado','Confiante','Instável','Descontrole'];
const STATE_COLORS = ['#889894','#6aa7c3','#4f9f63','#c8a938','#dd8a34','#d24f4f'];
const ERROR_LOCATIONS = [
  {key:'rede', label:'Rede', color:'#2d79cf'},
  {key:'fundo', label:'Fundo', color:'#d24f4f'},
  {key:'lado', label:'Lado', color:'#b85aa1'},
  {key:'df', label:'Dupla falta', color:'#2f9c59'}
];
const STROKE_COLORS = ['#3166b2','#7a6cdb','#2f9c59','#d24f4f','#c08b2f','#a35f48','#7a8c84'];
let DATA = null;
let COACH = null;
let AVAILABLE_COACH = [];
let POINTS = [];
let GAMES = [];
let VIEW = {zoom:1, pan:0};
let CHART_META = {};
let ZONE_INFO_OPEN = false;
const PAN_DRAG = {active:false, pointerId:null, lastX:0, canvas:null, raf:0};

if ('serviceWorker' in navigator && ['http:','https:'].includes(location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

$('#btnImport').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => importFiles([...e.target.files]);
$('#btnSample').onclick = loadSample;
$('#btnExport').onclick = e => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; };
$('#btnRefreshCoach').onclick = () => refreshCoachPicker(true);
$('#coachSelect').onchange = () => selectCoachGame($('#coachSelect').value);
$('#btnZonesInfo').onclick = () => { ZONE_INFO_OPEN = !ZONE_INFO_OPEN; renderZonesInfo(); };
document.addEventListener('click', e => { if (!e.target.closest('#btnExport') && !e.target.closest('#exportMenu')) $('#exportMenu').hidden = true; });
document.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => exportData(b.dataset.exp));
$('#zoomRange').oninput = e => setZoom(+e.target.value);
$('#zoomIn').onclick = () => setZoom(Math.min(8, VIEW.zoom + 0.5));
$('#zoomOut').onclick = () => setZoom(Math.max(1, VIEW.zoom - 0.5));
$('#zoomReset').onclick = () => { VIEW.pan = 0; setZoom(1); };

function setZoom(z){ VIEW.zoom = z; $('#zoomRange').value = z; clampPan(); drawAll(); }
function clampPan(){ const vis = 1/VIEW.zoom; const maxPan = vis>=1 ? 0 : 1; VIEW.pan = Math.max(0, Math.min(maxPan, VIEW.pan)); }

async function loadSample(){
  try{
    if(window.FISICO_SAMPLE_GARMIN && window.FISICO_SAMPLE_COACH){
      DATA = structuredClone(window.FISICO_SAMPLE_GARMIN);
      localStorage.setItem('avelicoach_example_game', JSON.stringify(structuredClone(window.FISICO_SAMPLE_COACH)));
      COACH = null; AVAILABLE_COACH = [];
      refreshCoachPicker(false);
      render();
      return;
    }
    throw new Error('Exemplo incorporado não encontrado.');
  }catch(err){ $('#status').textContent = 'Falha ao carregar exemplo: ' + err.message; }
}

async function importFiles(files){
  try{
    let entries = [];
    for(const f of files){
      const buf = await f.arrayBuffer();
      if(f.name.toLowerCase().endsWith('.zip')) entries.push(...await unzip(buf));
      else entries.push({name:f.name, buf});
    }
    let parsed = [];
    for(const e of entries){
      const n = e.name.toLowerCase();
      try{
        if(n.endsWith('.fit')) parsed.push(parseFIT(e.buf));
        else if(n.endsWith('.tcx')) parsed.push(parseTCX(new TextDecoder().decode(e.buf)));
        else if(n.endsWith('.gpx')) parsed.push(parseGPX(new TextDecoder().decode(e.buf)));
        else if(n.endsWith('.json')){
          const j = JSON.parse(new TextDecoder().decode(e.buf));
          if(j.game?.points || j.points) COACH = normalizeCoachGame(j.game || j);
          else if(j.records) parsed.push(j);
        }
      }catch(err){ console.warn('Falha ao ler', e.name, err); }
    }
    DATA = mergeActivities(parsed);
    if(!DATA) throw new Error('Nenhuma atividade compatível encontrada.');
    AVAILABLE_COACH = [];
    refreshCoachPicker(false);
    render();
  }catch(err){ $('#status').textContent = 'Falha na importação: ' + err.message; }
}

async function unzip(buf){
  const u = new Uint8Array(buf), out = [];
  let p = 0;
  while(p < u.length - 30){
    if(read32(u,p)!==0x04034b50){ p++; continue; }
    const method = read16(u,p+8), compSize = read32(u,p+18), nameLen = read16(u,p+26), extraLen = read16(u,p+28);
    const name = new TextDecoder().decode(u.slice(p+30,p+30+nameLen));
    const start = p+30+nameLen+extraLen;
    const raw = u.slice(start,start+compSize);
    let data;
    if(method===0) data = raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength);
    else if(method===8){
      const ds = new DecompressionStream('deflate-raw');
      data = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
    } else throw new Error('Método ZIP não suportado: ' + method);
    out.push({name, buf:data});
    p = start + compSize;
  }
  return out;
}

function parseTCX(txt){
  const x = new DOMParser().parseFromString(txt,'application/xml');
  const points = [...x.querySelectorAll('Trackpoint')].map(n=>({
    t: q(n,'Time'),
    lat: +q(n,'LatitudeDegrees'),
    lon: +q(n,'LongitudeDegrees'),
    hr: +q(n,'HeartRateBpm Value'),
    distance: +q(n,'DistanceMeters'),
    speed: +q(n,'Speed')
  })).filter(r=>r.t);
  const laps = [...x.querySelectorAll('Lap')];
  return {
    source:'TCX', sport:x.querySelector('Activity')?.getAttribute('Sport') || 'other',
    startTime: points[0]?.t, endTime: points.at(-1)?.t,
    durationSec: sum(laps,n=>+q(n,'TotalTimeSeconds')),
    distanceM: sum(laps,n=>+q(n,'DistanceMeters')),
    calories: sum(laps,n=>+q(n,'Calories')),
    avgHr: avg(laps.map(n=>+q(n,'AverageHeartRateBpm Value')).filter(Boolean)),
    maxHr: Math.max(0,...laps.map(n=>+q(n,'MaximumHeartRateBpm Value'))),
    records: points
  };
}
function parseGPX(txt){
  const x = new DOMParser().parseFromString(txt,'application/xml');
  const points = [...x.querySelectorAll('trkpt')].map(n=>({
    t: q(n,'time'), lat:+n.getAttribute('lat'), lon:+n.getAttribute('lon'), hr:+q(n,'hr')
  })).filter(r=>r.t);
  return { source:'GPX', startTime: points[0]?.t, endTime: points.at(-1)?.t, records: points };
}
function parseFIT(buf){
  const u = new Uint8Array(buf), dv = new DataView(buf), hlen=u[0], dataSize=dv.getUint32(4,true);
  let p=hlen, end=hlen+dataSize, defs={}, records=[], session={source:'FIT'};
  while(p<end){
    const h=u[p++], local=h&15;
    if(h&0x40){
      const dev = h&0x20; p++; const arch=u[p++], le=arch===0; const g=dv.getUint16(p,le); p+=2; const nf=u[p++]; const fields=[];
      for(let i=0;i<nf;i++){ fields.push({num:u[p], size:u[p+1], base:u[p+2]}); p+=3; }
      if(dev){ const nd=u[p++]; p += nd*3; }
      defs[local] = {g,le,fields}; continue;
    }
    const d=defs[local]; if(!d) break;
    const obj={};
    for(const f of d.fields){ obj[f.num]=fitVal(dv,p,f.size,f.base,d.le); p+=f.size; }
    if(d.g===20){
      const t=fitTime(obj[253]);
      if(t) records.push({t, lat:semi(obj[0]), lon:semi(obj[1]), hr:num(obj[3]), distance:num(obj[5])/100, speed:(num(obj[73])||num(obj[6]))/1000, cadence:num(obj[4]), temperature:num(obj[13])});
    } else if(d.g===18){
      session.startTime=fitTime(obj[2]); session.endTime=fitTime(obj[253]); session.durationSec=num(obj[7])/1000;
      session.distanceM=num(obj[9])/100; session.calories=num(obj[11]); session.avgHr=num(obj[16]); session.maxHr=num(obj[17]);
      session.aerobicTrainingEffect=num(obj[24])/10; session.anaerobicTrainingEffect=num(obj[137])/10; session.sport=fitSport(num(obj[5])); session.vo2MaxGarmin=num(obj[140])||null;
    }
  }
  session.records=records;
  if(!session.startTime) session.startTime = records[0]?.t;
  if(!session.endTime) session.endTime = records.at(-1)?.t;
  return session;
}
function mergeActivities(arr){
  if(!arr.length) return null;
  const fit = arr.find(x=>x.source==='FIT'); const tcx = arr.find(x=>x.source==='TCX'); const gpx = arr.find(x=>x.source==='GPX');
  const base = fit || tcx || gpx || arr[0];
  const records = fit?.records?.length ? fit.records : tcx?.records?.length ? tcx.records : gpx?.records || [];
  const merged = Object.assign({}, gpx, tcx, fit, base, {records, source:arr.map(x=>x.source).join('+')});
  merged.records = (merged.records||[]).map(r=>({...r, ms:Date.parse(r.t)})).filter(r=>Number.isFinite(r.ms)).sort((a,b)=>a.ms-b.ms);
  if(!merged.startTime) merged.startTime = merged.records[0]?.t;
  if(!merged.endTime) merged.endTime = merged.records.at(-1)?.t;
  if(!merged.durationSec && merged.startTime && merged.endTime) merged.durationSec = (Date.parse(merged.endTime)-Date.parse(merged.startTime))/1000;
  if((!merged.avgHr || !merged.maxHr) && merged.records.length){ const hrs = merged.records.map(r=>r.hr).filter(Boolean); if(hrs.length){ merged.avgHr = merged.avgHr || avg(hrs); merged.maxHr = merged.maxHr || Math.max(...hrs); } }
  return merged;
}

function coachStorages(){
  const stores=[];
  try{ stores.push({name:'localStorage', store:window.localStorage}); }catch{}
  try{ if(window.parent && window.parent!==window && window.parent.location.origin===location.origin) stores.push({name:'parent.localStorage', store:window.parent.localStorage}); }catch{}
  try{ if(window.top && window.top!==window && window.top.location.origin===location.origin) stores.push({name:'top.localStorage', store:window.top.localStorage}); }catch{}
  return stores;
}
function normalizeCoachGame(g){ if(g.game?.points) g = g.game; return g && Array.isArray(g.points) ? g : null; }
function extractCoachGames(value){
  const found=[]; const seen = new WeakSet();
  function walk(v, depth=0){
    if(v==null || depth>10) return;
    if(typeof v==='string'){
      const s=v.trim();
      if((s.startsWith('{')||s.startsWith('[')) && s.length>1){ try{ walk(JSON.parse(s), depth+1); }catch{} }
      return;
    }
    if(typeof v!=='object') return;
    if(seen.has(v)) return; seen.add(v);
    if(Array.isArray(v)){ v.forEach(x=>walk(x, depth+1)); return; }
    if(Array.isArray(v.points) && v.points.length) found.push(v);
    if(v.game && Array.isArray(v.game.points) && v.game.points.length) found.push(v.game);
    Object.entries(v).forEach(([k,x])=>{ if(k!=='points') walk(x, depth+1); });
  }
  walk(value);
  const uniq=[]; const ids = new Set();
  found.forEach(g=>{ const id = g.id || [g.date,g.startTime,g.opponent,(g.points||[]).length].join('|'); if(!ids.has(id)){ ids.add(id); uniq.push(g); } });
  return uniq;
}
function coachMatchScore(game, st, en){
  const pts = game.points || [];
  const times = pts.map(p=>Number(p.savedTimestampMs) || Date.parse(p.savedAt || p.savedAtLocal || p.createdAt)).filter(Number.isFinite);
  if(!times.length) return -Infinity;
  let score = 0;
  const inside = times.filter(t=>t>=st-3600000 && t<=en+3600000).length;
  score += inside * 10;
  const first = Math.min(...times), last = Math.max(...times);
  const overlap = Math.max(0, Math.min(last,en)-Math.max(first,st));
  score += overlap / 60000;
  score -= Math.min(Math.abs(first-st), Math.abs(last-en))/60000;
  const gameDate = game.date || pts[0]?.matchDate || pts[0]?.savedDate;
  if(gameDate && new Date(st).toISOString().slice(0,10)===String(gameDate).slice(0,10)) score += 200;
  return score;
}
function listCoachGamesInLocalStorage(data){
  const st = data ? Date.parse(data.startTime) : NaN, en = data ? Date.parse(data.endTime) : NaN;
  const out=[]; const ids=new Set();
  for(const src of coachStorages()){
    for(let i=0;i<src.store.length;i++){
      const key = src.store.key(i); const raw = src.store.getItem(key); if(!raw) continue;
      try{
        const games = extractCoachGames(JSON.parse(raw));
        games.forEach(game=>{
          const norm = normalizeCoachGame(game); if(!norm) return;
          const id = norm.id || key + '|' + (norm.points?.length||0) + '|' + (norm.opponent||'');
          if(ids.has(id)) return;
          ids.add(id);
          out.push({id, key, source:src.name, game:norm, score:Number.isFinite(st)&&Number.isFinite(en) ? coachMatchScore(norm,st,en) : 0});
        });
      }catch{}
    }
  }
  out.sort((a,b)=>b.score-a.score);
  return out;
}
function refreshCoachPicker(showMsg){
  AVAILABLE_COACH = listCoachGamesInLocalStorage(DATA);
  const select = $('#coachSelect');
  select.innerHTML = '';
  const none = new Option('Não cruzar com AveliCoach','');
  select.add(none);
  AVAILABLE_COACH.forEach((item,idx)=>{
    const label = coachLabel(item.game) + (Number.isFinite(item.score) ? ` • compatibilidade ${Math.round(item.score)}` : '');
    select.add(new Option(label, item.id));
  });
  $('#coachPicker').hidden = !DATA;
  if(COACH){
    const currentId = AVAILABLE_COACH.find(x=>sameCoach(x.game, COACH))?.id;
    select.value = currentId || '';
  } else if(AVAILABLE_COACH.length){
    select.value = AVAILABLE_COACH[0].id;
    COACH = wrapGame(AVAILABLE_COACH[0].game);
  } else select.value='';
  if(showMsg && !AVAILABLE_COACH.length) $('#status').textContent = 'Nenhum jogo/treino compatível foi encontrado no localStorage desta origem.';
}
function sameCoach(a,b){ return a && b && ((a.id && b.id && a.id===b.id) || ((a.opponent||'')===(b.game?.opponent||b.opponent||'') && (a.points?.length||0)===((b.game?.points||b.points||[]).length||0))); }
function selectCoachGame(id){
  if(!id){ COACH = null; render(); return; }
  const item = AVAILABLE_COACH.find(x=>x.id===id); if(!item) return;
  COACH = wrapGame(item.game); render();
}
function wrapGame(game){ return game?.game ? game : {game}; }
function coachLabel(game){ const pts=(game.points||[]).length; const date=game.date || game.points?.[0]?.matchDate || game.points?.[0]?.savedDate || 'sem data'; const t1=game.startTime || game.points?.[0]?.savedTime || '--'; const t2=game.endTime || game.points?.at(-1)?.savedTime || '--'; const who=game.opponent || game.title || game.tournament || 'treino'; return `${date} • ${t1}–${t2} • ${who} • ${pts} pontos`; }
function renderStatus(){
  if(!DATA) return;
  const parts = [];
  parts.push(DATA.source?.includes('SIMULAÇÃO') ? 'Exemplo simulado carregado.' : 'Atividade importada.');
  if(COACH?.game?.points?.length) parts.push(`AveliCoach selecionado: ${coachLabel(COACH.game)}.`);
  else parts.push('Nenhum jogo/treino selecionado.');
  if(location.protocol==='file:') parts.push('Observação: em file:// o módulo não acessa automaticamente o localStorage do site publicado.');
  $('#status').textContent = parts.join(' ');
}

function render(){
  if(!DATA) return;
  POINTS = buildPoints();
  GAMES = buildGames();
  $('#dashboard').hidden = false;
  renderStatus();
  renderSummary();
  renderZones();
  renderErrorTables();
  renderPointsTable();
  drawAll();
}

function getZoneBounds(){
  const max = Math.max(190, Math.round((DATA?.maxHr || 175) / 5) * 5);
  return [0, Math.round(max*0.50), Math.round(max*0.60), Math.round(max*0.70), Math.round(max*0.80), Math.round(max*0.90), max];
}
function getZoneLabel(i){ return ['Aquecimento','Fácil','Aeróbica','Limiar','Máximo'][i-1] || ''; }
function zoneOf(hr){ const b=getZoneBounds(); if(!hr || hr<b[1]) return 0; for(let i=1;i<=5;i++) if(hr>=b[i] && hr < (b[i+1] ?? Infinity)) return i; return 5; }

function buildPoints(){
  const game = COACH?.game;
  if(!game?.points?.length) return [];
  const rec = DATA.records || [];
  const hrs = rec.map(r=>r.hr).filter(Boolean).sort((a,b)=>a-b);
  const q = p => hrs.length ? hrs[Math.floor((hrs.length-1)*p)] : 0;
  const q20=q(.2), q40=q(.4), q60=q(.6), q80=q(.8);
  let presence = 0;
  const pts = game.points.map((p,i)=>({ ...p, order:p.order||i+1, time:Number(p.savedTimestampMs)||Date.parse(p.savedAt||p.savedAtLocal||p.createdAt) })).filter(p=>Number.isFinite(p.time)).sort((a,b)=>a.time-b.time);
  return pts.map((p,i)=>{
    const next = pts[i+1] || null;
    const prev = pts[i-1] || null;
    const pointRec = nearestRecord(p.time);
    const before = windowRecords(p.time-15000, p.time);
    const after = next ? windowRecords(p.time, next.time) : windowRecords(p.time, p.time+20000);
    const h = Math.round(avg(before.map(x=>x.hr).filter(Boolean)) || pointRec?.hr || 0);
    const afterHrs = after.map(x=>x.hr).filter(Boolean);
    const nextMin = afterHrs.length ? Math.min(...afterHrs) : h;
    const nextMax = afterHrs.length ? Math.max(...afterHrs) : h;
    const trend = Math.round(((avg(afterHrs)||h)-h)*10)/10;
    const intervalSec = next ? Math.max(0, Math.round((next.time-p.time)/1000)) : 0;
    const recoveryDrop = next ? Math.max(0, h - nextMin) : 0;
    const rNow = nearestRecord(p.time); const rNext = next ? nearestRecord(next.time) : null;
    const pointDistance = (rNow && rNext && Number.isFinite(rNow.distance) && Number.isFinite(rNext.distance)) ? Math.max(0, rNext.distance - rNow.distance) : 0;
    const win = p.winner === 'athlete';
    let delta = win ? 1 : -1;
    if(p.actor==='athlete' && p.ending==='erro') delta -= .3;
    if(p.ending==='dupla_falta') delta -= .5;
    if(p.momentManual==='pressao') delta *= 1.12;
    presence = Math.max(-12, Math.min(12, presence + delta));
    let state = h<q20?0 : h<q40?1 : h<q60?2 : h<q80?3 : 4;
    if(trend > 4 || recoveryDrop < 6 && zoneOf(h)>=4) state = Math.max(state,4);
    if(zoneOf(h)>=5 && (trend > 2 || recoveryDrop < 4)) state = 5;
    if(zoneOf(h)<=1 && recoveryDrop>=10) state = Math.min(state,1);
    return {
      ...p,
      idx:i,
      hr:h,
      zone:zoneOf(h),
      trend,
      recoveryDrop,
      intervalSec,
      pointDistance,
      nextMinHr:nextMin,
      nextMaxHr:nextMax,
      state,
      presence:Math.round(presence*10)/10,
      gameEnd: isGameEnd(pts,i),
      marker: markerOf(p),
      strokeLabel: strokeLabel(p.stroke, p.ending),
      locationLabel: locationLabel(p.place, p.ending)
    };
  });
}
function isGameEnd(pts, i){ if(i===pts.length-1) return true; return pts[i+1].server !== pts[i].server; }
function markerOf(p){ if(p.actor!=='athlete') return null; if(p.ending==='dupla_falta') return 'df'; if(p.ending==='erro' && p.place==='rede') return 'net'; if(p.ending==='erro' && p.place==='fora_fundo') return 'fundo'; if(p.ending==='erro' && p.place==='fora_lado') return 'lado'; return null; }
function strokeLabel(stroke, ending){ if(ending==='dupla_falta') return 'Saque'; const map={forehand:'Forehand',backhand:'Backhand',saque:'Saque',devolucao:'Devolução',voleio:'Voleio',smash:'Smash',nao_informado:'Não informado'}; return map[stroke] || (stroke ? capitalize(stroke) : 'Não informado'); }
function locationLabel(place, ending){ if(ending==='dupla_falta') return 'Dupla falta'; const map={rede:'Rede',fora_fundo:'Fundo',fora_lado:'Lado',nao_informado:'Não informado'}; return map[place] || 'Não informado'; }
function buildGames(){
  if(!POINTS.length) return [];
  const out=[]; let start=0, gameNo=1;
  POINTS.forEach((p,i)=>{
    if(p.gameEnd){
      const slice = POINTS.slice(start,i+1);
      out.push({
        game:gameNo++,
        startIndex:start,endIndex:i,
        points:slice,
        startHr:slice[0]?.hr||0,
        endHr:slice.at(-1)?.hr||0,
        avgHr:avg(slice.map(x=>x.hr).filter(Boolean))||0
      });
      start=i+1;
    }
  });
  return out;
}

function nearestRecord(ms){
  const arr=DATA.records||[]; if(!arr.length) return null;
  let lo=0, hi=arr.length-1;
  while(lo<hi){ const m=(lo+hi)>>1; if(arr[m].ms < ms) lo=m+1; else hi=m; }
  const cand = arr[lo]; const prev = arr[Math.max(0,lo-1)];
  return prev && Math.abs(prev.ms-ms) < Math.abs(cand.ms-ms) ? prev : cand;
}
function windowRecords(a,b){ return (DATA.records||[]).filter(r=>r.ms>=a && r.ms<=b); }

function renderSummary(){
  const items = [
    ['Data', fmtDate(DATA.startTime)],
    ['Duração', fmtDur(DATA.durationSec || ((Date.parse(DATA.endTime)-Date.parse(DATA.startTime))/1000))],
    ['Distância', ((DATA.distanceM||0)/1000).toFixed(2)+' km'],
    ['FC média', Math.round(DATA.avgHr || avg((DATA.records||[]).map(r=>r.hr).filter(Boolean))) + ' bpm'],
    ['FC máxima', Math.round(DATA.maxHr || Math.max(...(DATA.records||[]).map(r=>r.hr||0))) + ' bpm'],
    ['Calorias', (DATA.calories ?? '—')]
  ];
  $('#summary').innerHTML = items.map(([a,b])=>`<div class="metric"><small>${a}</small><b>${b}</b></div>`).join('');
}

function drawAll(){
  drawPresence();
  drawHrChart();
  drawSpeedChart();
  drawRecoveryChart();
  drawIntervalChart();
  drawDistanceChart();
  drawGameHrChart();
}

function timeWindow(){
  const arr = DATA.records||[]; const t0 = arr[0]?.ms || Date.parse(DATA.startTime); const t1 = arr.at(-1)?.ms || Date.parse(DATA.endTime);
  const vis = 1/VIEW.zoom; const span = (t1-t0)*vis; const start = t0 + (t1-t0-span) * VIEW.pan; return {t0,t1,start,end:start+span};
}
function timeX(ms, w, L, R, W){ return L + (ms - w.start) / Math.max(1, w.end-w.start) * (W-L-R); }
function visibleRecords(){ const w=timeWindow(); return (DATA.records||[]).filter(r=>r.ms>=w.start && r.ms<=w.end); }
function visiblePoints(){ const w=timeWindow(); return POINTS.filter(p=>p.time>=w.start && p.time<=w.end); }
function attachPanZoom(canvas){
  if(canvas.dataset.panZoomBound==='1') return;
  canvas.dataset.panZoomBound='1';
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const old=VIEW.zoom, rect=canvas.getBoundingClientRect(), cursor=(e.clientX-rect.left)/Math.max(1,rect.width);
    VIEW.zoom=Math.max(1,Math.min(8,VIEW.zoom*(e.deltaY<0?1.15:.87)));
    $('#zoomRange').value=VIEW.zoom;
    const oldVis=1/old, newVis=1/VIEW.zoom, focus=VIEW.pan*(1-oldVis)+cursor*oldVis;
    VIEW.pan = newVis>=1 ? 0 : Math.max(0,Math.min(1-newVis,focus-cursor*newVis));
    drawAll();
  }, {passive:false});
  canvas.addEventListener('pointerdown', e => {
    if(VIEW.zoom<=1) return;
    PAN_DRAG.active=true; PAN_DRAG.pointerId=e.pointerId; PAN_DRAG.lastX=e.clientX; PAN_DRAG.canvas=canvas;
    canvas.classList.add('dragging');
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if(!PAN_DRAG.active || PAN_DRAG.pointerId!==e.pointerId || PAN_DRAG.canvas!==canvas) return;
    const dx=e.clientX-PAN_DRAG.lastX; PAN_DRAG.lastX=e.clientX;
    const vis=1/VIEW.zoom;
    VIEW.pan=Math.max(0,Math.min(1-vis,VIEW.pan-dx/Math.max(1,canvas.clientWidth)*vis));
    if(!PAN_DRAG.raf){ PAN_DRAG.raf=requestAnimationFrame(()=>{ PAN_DRAG.raf=0; drawAll(); }); }
    e.preventDefault();
  });
  const end=e=>{
    if(PAN_DRAG.pointerId!==null && e.pointerId!==undefined && PAN_DRAG.pointerId!==e.pointerId) return;
    PAN_DRAG.active=false; PAN_DRAG.pointerId=null;
    if(PAN_DRAG.canvas) PAN_DRAG.canvas.classList.remove('dragging');
    PAN_DRAG.canvas=null;
  };
  canvas.addEventListener('pointerup',end);
  canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('lostpointercapture',end);
}

function baseCanvas(canvasId, height){
  const c=$(canvasId); if(!c) return {c:null,ctx:null,W:0,H:height};
  const box=c.parentElement.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
  const targetW=Math.max(1,Math.floor(box.width*dpr)), targetH=Math.max(1,Math.floor(height*dpr));
  if(c.width!==targetW) c.width=targetW;
  if(c.height!==targetH) c.height=targetH;
  const ctx=c.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,box.width,height);
  attachPanZoom(c);
  return {c,ctx,W:box.width,H:height};
}
function drawPresence(){
  const {c,ctx: x,W,H} = baseCanvas('#presenceChart',520); const w=timeWindow(); const pts=POINTS; if(!pts.length) return;
  const L=52,R=18,T=18,plotH=282,stateY=336,stateH=64,bottom=48; const y=v=>T+(12-v)/24*plotH;
  drawPlotGrid(x,{L,R,T,B:H-bottom},[-10,-5,0,5,10],v=>y(v));
  x.strokeStyle='#1c6550'; x.lineWidth=2.2; x.beginPath(); let started=false;
  pts.forEach(p=>{ if(p.time<w.start || p.time>w.end) return; const xx=timeX(p.time,w,L,R,W), yy=y(p.presence); if(!started){ x.moveTo(xx,yy); started=true; } else x.lineTo(xx,yy); }); x.stroke();
  pts.forEach(p=>{ if(p.time<w.start || p.time>w.end) return; const xx=timeX(p.time,w,L,R,W), yy=y(p.presence); if(p.gameEnd){ drawVLine(x,xx,T,stateY+stateH,'#7f918a'); }
    if(p.marker==='fundo' || p.marker==='lado'){ x.fillStyle='#d24f4f'; x.beginPath(); x.arc(xx,yy,4.6,0,Math.PI*2); x.fill(); }
    else if(p.marker==='net'){ x.fillStyle='#2d79cf'; x.beginPath(); x.arc(xx,yy,4.6,0,Math.PI*2); x.fill(); }
    else if(p.marker==='df'){ x.fillStyle='#2f9c59'; x.beginPath(); x.moveTo(xx,yy-6); x.lineTo(xx-5.5,yy+4.5); x.lineTo(xx+5.5,yy+4.5); x.closePath(); x.fill(); }
  });
  x.fillStyle='#4e6760'; x.font='12px system-ui'; x.fillText('Presença',10,16); x.fillText('Estado fisiológico estimado',10,stateY-8);
  const visPts = pts.filter(p=>p.time>=w.start && p.time<=w.end); const segW = visPts.length ? (W-L-R)/visPts.length : 8;
  visPts.forEach((p,i)=>{ const xx=timeX(p.time,w,L,R,W); x.fillStyle = STATE_COLORS[p.state]; x.fillRect(xx-segW/2, stateY, Math.max(2,segW+1), stateH); if(segW>34){ x.save(); x.translate(xx, stateY+stateH/2); x.rotate(-Math.PI/2); x.fillStyle='#fff'; x.font='bold 10px system-ui'; x.textAlign='center'; x.fillText(STATES[p.state],0,4); x.restore(); } });
  drawTimeAxis(x,w,{L,R,W,H,axisY:H-28}, pts.filter(p=>p.gameEnd).map(p=>p.time));
  registerTip(c, (mx,my)=>{
    const p = nearestPointByX(mx,w,L,R,W); if(!p) return null;
    return `<b>Ponto ${p.order}</b><br>${new Date(p.time).toLocaleTimeString('pt-BR')} • ${p.hr} bpm • Z${p.zone||'—'}<br>${STATES[p.state]} • presença ${p.presence}<br>${labelMarker(p.marker)||labelEnding(p.ending)} • ${p.strokeLabel}`;
  });
}
function drawHrChart(){
  const {c,ctx:x,W,H} = baseCanvas('#hrChart',250); const w=timeWindow(); const rec=visibleRecords(); if(!rec.length) return;
  const L=45,R=16,T=16,B=30; const min=70,max=Math.max(190, Math.ceil((DATA.maxHr||180)/10)*10); const py=v=>T+(max-v)/(max-min)*(H-T-B);
  const zb=getZoneBounds();
  for(let i=1;i<=5;i++){ const y1=py(zb[i+1]||max), y2=py(zb[i]); x.fillStyle=hexAlpha(STATE_COLORS[Math.min(i,STATE_COLORS.length-1)],0.11); x.fillRect(L,y1,W-L-R,y2-y1); }
  drawPlotGrid(x,{L,R,T,B},[80,100,120,140,160,180],v=>py(v));
  x.strokeStyle='#1c6550'; x.lineWidth=1.8; x.beginPath(); rec.forEach((r,i)=>{ const xx=timeX(r.ms,w,L,R,W), yy=py(r.hr||0); i?x.lineTo(xx,yy):x.moveTo(xx,yy); }); x.stroke();
  POINTS.filter(p=>p.gameEnd && p.time>=w.start && p.time<=w.end).forEach(p=>drawVLine(x,timeX(p.time,w,L,R,W),T,H-B,'#7f918a'));
  drawTimeAxis(x,w,{L,R,W,H,axisY:H-16}, POINTS.filter(p=>p.gameEnd).map(p=>p.time));
  registerTip(c, (mx,my)=>{ const r=nearestRecordAtX(mx,w,L,R,W); if(!r) return null; return `<b>${new Date(r.ms).toLocaleTimeString('pt-BR')}</b><br>${Math.round(r.hr||0)} bpm • Z${zoneOf(r.hr)}<br>FC registrada pelo Garmin`; });
}
function drawSpeedChart(){
  const {c,ctx:x,W,H} = baseCanvas('#speedChart',230); const w=timeWindow(); const rec=visibleRecords(); if(!rec.length) return;
  const L=45,R=16,T=16,B=30; const vals = rec.map(r=>(r.speed||0)*3.6).filter(v=>Number.isFinite(v)); const vmax = Math.max(6, Math.ceil((Math.max(...vals,0))*1.15)); const py=v=>T+(vmax-v)/vmax*(H-T-B);
  drawPlotGrid(x,{L,R,T,B},niceTicks(vmax,5),v=>py(v));
  x.strokeStyle='#3f7e66'; x.lineWidth=1.8; x.beginPath(); rec.forEach((r,i)=>{ const xx=timeX(r.ms,w,L,R,W), yy=py((r.speed||0)*3.6); i?x.lineTo(xx,yy):x.moveTo(xx,yy); }); x.stroke();
  POINTS.filter(p=>p.gameEnd && p.time>=w.start && p.time<=w.end).forEach(p=>drawVLine(x,timeX(p.time,w,L,R,W),T,H-B,'#7f918a'));
  drawTimeAxis(x,w,{L,R,W,H,axisY:H-16}, POINTS.filter(p=>p.gameEnd).map(p=>p.time));
  registerTip(c, (mx,my)=>{ const r=nearestRecordAtX(mx,w,L,R,W); if(!r) return null; return `<b>${new Date(r.ms).toLocaleTimeString('pt-BR')}</b><br>${((r.speed||0)*3.6).toFixed(2)} km/h`; });
}
function drawRecoveryChart(){ drawPointBars('#recoveryChart', POINTS.map(p=>({time:p.time,label:p.order,val:p.recoveryDrop,color:'#5c8f73'})), 'Queda de BPM', 'bpm', p=>`Ponto ${p.label}<br>Queda: ${p.val.toFixed(0)} bpm`); }
function drawIntervalChart(){ drawPointBars('#intervalChart', POINTS.slice(0,-1).map(p=>({time:p.time,label:p.order,val:p.intervalSec,color:'#c58a37'})), 'Intervalo', 's', p=>`Ponto ${p.label}<br>Intervalo: ${p.val.toFixed(0)} s`); }
function drawDistanceChart(){ drawPointBars('#distanceChart', POINTS.slice(0,-1).map(p=>({time:p.time,label:p.order,val:p.pointDistance,color:'#3a78b7'})), 'Distância', 'm', p=>`Ponto ${p.label}<br>Distância: ${p.val.toFixed(1)} m`); }
function drawPointBars(canvasId, items, yTitle, unit, tipFn){
  const {c,ctx:x,W,H} = baseCanvas(canvasId,220); const w=timeWindow(); const vis=items.filter(p=>p.time>=w.start&&p.time<=w.end); if(!vis.length) return;
  const L=45,R=16,T=16,B=30; const vmax = Math.max(1, Math.ceil(Math.max(...vis.map(v=>v.val))*1.15)); const py=v=>T+(vmax-v)/vmax*(H-T-B); drawPlotGrid(x,{L,R,T,B},niceTicks(vmax,4),v=>py(v));
  const barW = Math.max(3, (W-L-R)/Math.max(vis.length,1)*0.7);
  vis.forEach(p=>{ const xx=timeX(p.time,w,L,R,W); x.fillStyle=p.color; x.fillRect(xx-barW/2, py(p.val), barW, H-B-py(p.val)); });
  POINTS.filter(p=>p.gameEnd && p.time>=w.start && p.time<=w.end).forEach(p=>drawVLine(x,timeX(p.time,w,L,R,W),T,H-B,'#7f918a'));
  drawTimeAxis(x,w,{L,R,W,H,axisY:H-16}, POINTS.filter(p=>p.gameEnd).map(p=>p.time));
  x.fillStyle='#536b64'; x.font='11px system-ui'; x.fillText(unit,10,15);
  registerTip(c, (mx,my)=>{ const p=nearestByX(vis,mx,w,L,R,W); return p? tipFn(p) : null; });
}
function drawGameHrChart(){
  const {c,ctx:x,W,H} = baseCanvas('#gameHrChart',220); if(!GAMES.length) return;
  const L=40,R=12,T=18,B=28; const vmax = Math.max(...GAMES.map(g=>Math.max(g.startHr,g.endHr)), 130) + 10; const vmin = Math.max(60, Math.min(...GAMES.map(g=>Math.min(g.startHr,g.endHr)), 100)-10); const py=v=>T+(vmax-v)/(vmax-vmin)*(H-T-B);
  drawPlotGrid(x,{L,R,T,B},niceTicks(vmax,4,vmin),v=>py(v));
  const gap=(W-L-R)/GAMES.length; const bw=Math.min(18,gap*0.28);
  GAMES.forEach((g,i)=>{ const cx=L+gap*i+gap/2; x.fillStyle='#3b7b5e'; x.fillRect(cx-bw-2, py(g.startHr), bw, H-B-py(g.startHr)); x.fillStyle='#c8a938'; x.fillRect(cx+2, py(g.endHr), bw, H-B-py(g.endHr)); x.fillStyle='#546c65'; x.textAlign='center'; x.fillText('G'+g.game,cx,H-10); });
  x.textAlign='left';
  registerTip(c, (mx,my)=>{ const gap=(W-L-R)/GAMES.length; const idx=Math.max(0, Math.min(GAMES.length-1, Math.floor((mx-L)/gap))); const g=GAMES[idx]; if(!g) return null; return `<b>Game ${g.game}</b><br>FC inicial: ${Math.round(g.startHr)} bpm<br>FC final: ${Math.round(g.endHr)} bpm<br>FC média: ${Math.round(g.avgHr)} bpm`; });
}
function drawErrorLocationChart(){
  const rows = stateLocationStats();
  drawGroupedStateChart('#errorLocationChart', rows, ERROR_LOCATIONS.map(x=>x.label), ERROR_LOCATIONS.map(x=>x.color), r=>ERROR_LOCATIONS.map(x=>r.values[x.key]||0));
}
function drawErrorStrokeChart(){
  const rows = stateStrokeStats(); const cats = strokeCategories(rows);
  drawGroupedStateChart('#errorStrokeChart', rows, cats, cats.map((_,i)=>STROKE_COLORS[i%STROKE_COLORS.length]), r=>cats.map(c=>r.values[c]||0));
}
function drawGroupedStateChart(canvasId, rows, cats, colors, valueExtractor){
  const {c,ctx:x,W,H} = baseCanvas(canvasId, canvasId==='#errorStrokeChart'?270:250); if(!rows.length) return;
  const L=86,R=14,T=18,B=26; const band=(H-T-B)/rows.length; const usable=W-L-R; const gap = 6; const groups = cats.length; const barW=Math.max(6, (usable-40)/Math.max(groups,1)/rows.length * 0.9);
  const max = Math.max(1,...rows.flatMap(r=>valueExtractor(r)));
  rows.forEach((r,ri)=>{
    const y=T+ri*band+band*0.2; x.fillStyle=STATE_COLORS[r.index]; x.fillRect(8,y+2,60,band*0.42); x.fillStyle='#fff'; x.font='11px system-ui'; x.fillText(r.state,12,y+16);
    valueExtractor(r).forEach((v,ci)=>{ const xx=L + ci*(usable/groups) + 6; const h=(v/max)*(band*0.46); x.fillStyle=colors[ci]; x.fillRect(xx, y+band*0.52-h, Math.min(barW, (usable/groups)-10), h); if(v>0){ x.fillStyle='#516963'; x.font='10px system-ui'; x.fillText(String(v), xx, y+band*0.52-h-2); } });
  });
  cats.forEach((cat,ci)=>{ const xx=L + ci*(usable/groups) + 6; x.save(); x.translate(xx+8,H-4); x.rotate(-Math.PI/5); x.fillStyle='#576f67'; x.font='10px system-ui'; x.fillText(cat,0,0); x.restore(); });
}

function drawPlotGrid(ctx, box, ticks, yFn){ const {L,R,T,B}=box; ctx.strokeStyle='#d5e0db'; ctx.lineWidth=1; ctx.fillStyle='#5a726a'; ctx.font='11px system-ui'; ticks.forEach(v=>{ const y=yFn(v); ctx.beginPath(); ctx.moveTo(L,y); ctx.lineTo((ctx.canvas.width/(window.devicePixelRatio||1))-R,y); ctx.stroke(); ctx.fillText(String(Math.round(v)),8,y+4); }); }
function drawVLine(ctx,x,y1,y2,color){ ctx.strokeStyle=color; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x,y1); ctx.lineTo(x,y2); ctx.stroke(); }
function drawTimeAxis(ctx,w,box,gameTimes){ const {L,R,W,H,axisY}=box; ctx.strokeStyle='#5e756d'; ctx.fillStyle='#5e756d'; ctx.font='11px system-ui'; ctx.textAlign='center'; const ticks=5; for(let i=0;i<=ticks;i++){ const t=w.start + (w.end-w.start)*i/ticks; const xx=L+(W-L-R)*i/ticks; ctx.fillText(fmtTimeShort(t), xx, axisY); } gameTimes.filter(t=>t>=w.start&&t<=w.end).forEach((t,i)=>{ const xx=timeX(t,w,L,R,W); ctx.fillText('G', xx, axisY-14); }); ctx.textAlign='left'; }
function registerTip(canvas, htmlFn){ canvas.onmousemove = e => { const rect=canvas.getBoundingClientRect(), html = htmlFn(e.clientX-rect.left, e.clientY-rect.top); if(!html){ $('#pointTip').hidden=true; return; } const tip=$('#pointTip'); tip.innerHTML = html; tip.style.left = Math.min(window.innerWidth-260, e.clientX+14)+'px'; tip.style.top = Math.min(window.innerHeight-130, e.clientY+14)+'px'; tip.hidden = false; }; canvas.onmouseleave = () => { if(!canvas.classList.contains('dragging')) $('#pointTip').hidden=true; }; }
function nearestPointByX(mx,w,L,R,W){ const vis=POINTS.filter(p=>p.time>=w.start&&p.time<=w.end); return nearestByX(vis,mx,w,L,R,W); }
function nearestRecordAtX(mx,w,L,R,W){ const vis=visibleRecords(); return nearestByX(vis,mx,w,L,R,W, r=>r.ms); }
function nearestByX(arr,mx,w,L,R,W,timeGetter){ if(!arr.length) return null; const getter=timeGetter || (p=>p.time); let best=arr[0], bd=Infinity; arr.forEach(item=>{ const d=Math.abs(timeX(getter(item),w,L,R,W)-mx); if(d<bd){ bd=d; best=item; } }); return best; }

function renderZones(){
  const bounds = getZoneBounds(); const totalRecords = (DATA.records||[]).length || 1; const counts = [0,0,0,0,0]; let un=0;
  (DATA.records||[]).forEach(r=>{ const z=zoneOf(r.hr); if(z===0) un++; else counts[z-1]++; });
  const html = counts.map((count,i)=>{
    const bpm = `${bounds[i+1]}–${bounds[i+2]} bpm`;
    const pct = count/totalRecords*100;
    const timeSec = estimateDurationFromCount(count);
    return `<div class="zone-row"><div class="zone-title"><b>Zona ${i+1}</b><span>${bpm} · ${getZoneLabel(i+1)}</span></div><div class="bar"><i style="width:${pct.toFixed(1)}%;background:${STATE_COLORS[i+1]}"></i></div><div>${fmtDurShort(timeSec)}</div><div>${pct.toFixed(1)}%</div></div>`;
  }).join('') + `<div class="zone-row"><div class="zone-title"><b>Não mensurável</b><span>Abaixo da Zona 1 ou sem leitura válida</span></div><div class="bar"><i style="width:${(un/totalRecords*100).toFixed(1)}%;background:#8f9c97"></i></div><div>${fmtDurShort(estimateDurationFromCount(un))}</div><div>${(un/totalRecords*100).toFixed(1)}%</div></div>`;
  $('#zones').innerHTML = html;
  renderZonesInfo();
}
function renderZonesInfo(){
  const box = $('#zonesInfo'); box.hidden = !ZONE_INFO_OPEN; if(!ZONE_INFO_OPEN) return;
  box.innerHTML = `
    <h3>Zonas de frequência cardíaca</h3>
    <p>As zonas de frequência cardíaca são uma medida útil da intensidade do treino. Enquanto você monitora uma atividade, seu dispositivo Garmin registra seu tempo gasto em cinco zonas de frequência cardíaca diferentes e fornece um gráfico dessas informações nos detalhes da sua atividade.</p>
    <h3>Opções de personalização</h3>
    <p>Seu dispositivo Garmin usa seu máximo de batimentos por minuto (BPM) para estabelecer suas zonas de frequência cardíaca padrão. Se desejar, você pode alterar essas zonas para melhor corresponder à forma como deseja treinar.</p>
    <h3>Ajustar as zonas de FC</h3>
    <p>Você pode ajustar suas zonas de frequência cardíaca alterando os valores mínimo e máximo de BPM para cada uma. Além disso, dispositivos compatíveis da Garmin permitem escolher o modo como as zonas são medidas, como porcentagem da FC máxima, reserva de FC ou limiar de lactato.</p>
    <h3>Saiba mais sobre as zonas de FC</h3>
    <p>Cada zona de frequência cardíaca tem um impacto exclusivo no corpo durante o treino. Em geral, as zonas inferiores são melhores para aquecimento e recuperação, enquanto as zonas mais altas resultam em melhorias de potência e resistência.</p>
    <ul>
      <li><b>Zona 1 (Aquecimento)</b>: 50–60% da FC máxima.</li>
      <li><b>Zona 2 (Fácil)</b>: 60–70% da FC máxima.</li>
      <li><b>Zona 3 (Aeróbica)</b>: 70–80% da FC máxima.</li>
      <li><b>Zona 4 (Limiar)</b>: 80–90% da FC máxima.</li>
      <li><b>Zona 5 (Máximo)</b>: 90–100% da FC máxima.</li>
      <li><b>Não mensurável</b>: quando a frequência cardíaca ficou abaixo da Zona 1 ou sem leitura válida.</li>
    </ul>
    <p><b>Confiança: alta</b> quando os limites da zona vierem da atividade ou da configuração padrão aplicada de forma consistente ao arquivo importado.</p>`;
}
function estimateDurationFromCount(count){ const rec=DATA.records||[]; if(rec.length<2) return 0; const step = ((rec.at(-1).ms - rec[0].ms) / Math.max(1, rec.length-1))/1000; return count*step; }

function stateLocationStats(){
  return STATES.map((state,index)=>{ const values={rede:0,fundo:0,lado:0,df:0}; POINTS.forEach(p=>{ if(p.state!==index || p.actor!=='athlete') return; if(p.ending==='dupla_falta') values.df++; else if(p.ending==='erro' && p.place==='rede') values.rede++; else if(p.ending==='erro' && p.place==='fora_fundo') values.fundo++; else if(p.ending==='erro' && p.place==='fora_lado') values.lado++; }); return {state,index,values,total:Object.values(values).reduce((a,b)=>a+b,0)}; });
}
function stateStrokeStats(){
  return STATES.map((state,index)=>{ const values={}; POINTS.forEach(p=>{ if(p.state!==index || p.actor!=='athlete') return; if(p.ending!=='erro' && p.ending!=='dupla_falta') return; const key = strokeLabel(p.stroke,p.ending); values[key]=(values[key]||0)+1; }); return {state,index,values,total:Object.values(values).reduce((a,b)=>a+b,0)}; });
}
function strokeCategories(rows){ const set = new Set(); rows.forEach(r=>Object.keys(r.values).forEach(k=>set.add(k))); return [...set]; }
function renderErrorTables(){
  const locRows = stateLocationStats();
  $('#errorLocationTable').innerHTML = '<thead><tr><th>Estado fisiológico</th><th>Total</th><th>Rede</th><th>Fundo</th><th>Lado</th><th>Dupla falta</th></tr></thead><tbody>' + locRows.map(r=>`<tr><td><span class="state-pill" style="background:${hexAlpha(STATE_COLORS[r.index],.18)};color:${STATE_COLORS[r.index]}">${r.state}</span></td><td>${r.total}</td>${ERROR_LOCATIONS.map(c=>`<td>${fmtPctCount(r.values[c.key]||0,r.total)}</td>`).join('')}</tr>`).join('') + '</tbody>';
  const strokeRows = stateStrokeStats(); const cats = strokeCategories(strokeRows);
  $('#errorStrokeTable').innerHTML = '<thead><tr><th>Estado fisiológico</th><th>Total</th>' + cats.map(c=>`<th>${c}</th>`).join('') + '</tr></thead><tbody>' + strokeRows.map(r=>`<tr><td><span class="state-pill" style="background:${hexAlpha(STATE_COLORS[r.index],.18)};color:${STATE_COLORS[r.index]}">${r.state}</span></td><td>${r.total}</td>${cats.map(c=>`<td>${fmtPctCount(r.values[c]||0,r.total)}</td>`).join('')}</tr>`).join('') + '</tbody>';
}
function fmtPctCount(count,total){ return `${total?((count/total)*100).toFixed(1):'0.0'}% (${count})`; }

function renderPointsTable(){
  const rows = POINTS.map((p,i)=>`<tr><td>${i+1}</td><td>${new Date(p.time).toLocaleTimeString('pt-BR')}</td><td>${STATES[p.state]}</td><td>${p.hr}</td><td>Z${p.zone||'—'}</td><td>${labelMarker(p.marker)||labelEnding(p.ending)}</td><td>${p.strokeLabel}</td><td>${p.locationLabel}</td><td>${p.winner==='athlete'?'Ganho':'Perdido'}</td><td>${p.momentAuto || p.momentManual || 'normal'}</td><td>${p.recoveryDrop}</td><td>${p.pointDistance.toFixed(1)}</td></tr>`).join('');
  $('#pointsTable').innerHTML = `<thead><tr><th>Ponto</th><th>Horário</th><th>Estado fisiológico</th><th>BPM</th><th>ZC</th><th>Encerramento</th><th>Golpe</th><th>Local</th><th>Resultado</th><th>Momento</th><th>Recup. (bpm)</th><th>Dist. (m)</th></tr></thead><tbody>${rows}</tbody>`;
}

function labelMarker(m){ return m==='df'?'Dupla falta':m==='net'?'Erro na rede':(m==='fundo'||m==='lado')?'Erro fundo/lado':''; }
function labelEnding(e){ const map={erro:'Erro',winner:'Winner',dupla_falta:'Dupla falta',nao_informado:'Não informado'}; return map[e] || capitalize(String(e||'')); }
function fmtDate(s){ return s ? new Date(s).toLocaleDateString('pt-BR') : '—'; }
function fmtDur(s){ s=Math.round(s||0); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return `${h}h ${String(m).padStart(2,'0')}min`; }
function fmtDurShort(s){ s=Math.round(s||0); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60; if(h) return `${h}h${String(m).padStart(2,'0')}`; if(m) return `${m}min`; return `${sec}s`; }
function fmtTimeShort(ms){ return new Date(ms).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
function q(n,s){ return n.querySelector(s)?.textContent || ''; }
function sum(a,f){ return a.reduce((s,x)=>s+(f(x)||0),0); }
function avg(a){ return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0; }
function read16(u,p){ return u[p] | (u[p+1]<<8); }
function read32(u,p){ return (u[p] | (u[p+1]<<8) | (u[p+2]<<16) | (u[p+3]<<24))>>>0; }
function fitVal(dv,p,s,b,le){ const base=b&31; try{ if(s===1) return [0,2,10,13].includes(base)?dv.getUint8(p):dv.getInt8(p); if(s===2) return [4,11].includes(base)?dv.getUint16(p,le):dv.getInt16(p,le); if(s===4) return [6,12].includes(base)?dv.getUint32(p,le):base===8?dv.getFloat32(p,le):dv.getInt32(p,le); if(s===8) return base===9?dv.getFloat64(p,le):Number(dv.getBigUint64(p,le)); }catch{} return 0; }
function fitTime(v){ return v ? new Date((v+631065600)*1000).toISOString() : null; }
function semi(v){ return v==null ? null : v*180/2147483648; }
function fitSport(v){ return v===30?'tennis':v===1?'running':v===2?'cycling':'other'; }
function num(v){ return Number.isFinite(+v) ? +v : 0; }
function capitalize(s){ return s ? s.charAt(0).toUpperCase()+s.slice(1) : ''; }
function niceTicks(max, n=4, min=0){ const step=(max-min)/n; return Array.from({length:n+1}, (_,i)=>min+i*step); }
function hexAlpha(hex,a){ const h=hex.replace('#',''); const num=parseInt(h,16); const r=(num>>16)&255,g=(num>>8)&255,b=num&255; return `rgba(${r},${g},${b},${a})`; }

function exportData(type){
  $('#exportMenu').hidden=true;
  const payload={exportedAt:new Date().toISOString(),version:'Fisico_v1.4',activity:DATA,coach:COACH,points:POINTS,games:GAMES};
  if(type==='json') download('fisico_'+fmtFileDate()+'.json', JSON.stringify(payload,null,2), 'application/json');
  else if(type==='html') exportStandaloneHtml(payload);
  else if(type==='pdf') exportDirectPdf(payload);
}

function canvasSnapshot(id){
  const c=$(id); return c ? c.toDataURL('image/png') : '';
}
function collectEmbeddedCss(){
  let css='';
  for(const sheet of [...document.styleSheets]){
    try{ css += [...sheet.cssRules].map(r=>r.cssText).join('\n')+'\n'; }catch{}
  }
  return css;
}
function exportStandaloneHtml(payload){
  const chartIds=['#presenceChart','#hrChart','#speedChart','#recoveryChart','#intervalChart','#distanceChart','#gameHrChart'];
  const chartTitles=['Presença e estado fisiológico por ponto','BPM e zona cardíaca','Velocidade ao longo do tempo','Recuperação cardíaca entre pontos','Intervalo entre pontos','Distância por ponto','FC inicial × final de cada game'];
  const charts=chartIds.map((id,i)=>({title:chartTitles[i],src:canvasSnapshot(id)}));
  const summary=$('#summary').innerHTML;
  const zones=$('#zones').innerHTML;
  const errorLocation=$('#errorLocationTable').outerHTML;
  const errorStroke=$('#errorStrokeTable').outerHTML;
  const points=$('#pointsTable').outerHTML;
  const css=collectEmbeddedCss()+`body{padding:18px}.export-toolbar{display:flex;gap:8px;margin-bottom:12px}.export-chart{margin:12px 0;padding:12px;border:1px solid #c3d2ca;border-radius:12px;background:#eef3ef}.export-chart img{width:100%;display:block}.export-only{display:block}header,.actions,#status,#coachPicker,#dashboard,.menu,.tip{display:none!important}`;
  const safePayload=JSON.stringify(payload).replace(/</g,'\\u003c');
  const html=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Físico — ${fmtFileDate()}</title><style>${css}</style></head><body><h1>Físico — Avelitrix</h1><div class="export-toolbar"><button id="btnJson">Baixar JSON</button></div><div class="summary">${summary}</div>${charts.map(c=>`<section class="export-chart"><h2>${c.title}</h2><img src="${c.src}" alt="${c.title}"></section>`).join('')}<section class="card"><h2>Zonas na atividade</h2>${zones}</section><section class="card"><h2>Estado fisiológico × local do erro</h2>${errorLocation}</section><section class="card"><h2>Estado fisiológico × golpe errado</h2>${errorStroke}</section><section class="card"><h2>Pontos sincronizados</h2><div class="tablewrap">${points}</div></section><script>const REPORT=${safePayload};document.getElementById('btnJson').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(REPORT,null,2)],{type:'application/json'}));a.download='fisico_'+new Date(REPORT.activity.startTime).toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)};<\/script></body></html>`;
  download('fisico_'+fmtFileDate()+'.html',html,'text/html');
}

async function exportDirectPdf(payload){
  const pages=[];
  pages.push(makeSummaryPdfPage());
  const charts=[
    ['Presença e estado fisiológico por ponto','#presenceChart'],
    ['BPM e zona cardíaca','#hrChart'],
    ['Velocidade ao longo do tempo','#speedChart'],
    ['Recuperação cardíaca entre pontos','#recoveryChart'],
    ['Intervalo entre pontos','#intervalChart'],
    ['Distância por ponto','#distanceChart'],
    ['FC inicial × final de cada game','#gameHrChart']
  ];
  charts.forEach(([title,id])=>pages.push(makeChartPdfPage(title,$(id))));
  pages.push(...makeTablePdfPages('Estado fisiológico × local do erro',$('#errorLocationTable'),24));
  pages.push(...makeTablePdfPages('Estado fisiológico × golpe errado',$('#errorStrokeTable'),24));
  pages.push(...makeTablePdfPages('Pontos sincronizados',$('#pointsTable'),30));
  const blob=buildPdfFromCanvases(pages);
  downloadBlob('fisico_'+fmtFileDate()+'.pdf',blob);
}
function makePageCanvas(){ const c=document.createElement('canvas'); c.width=1400; c.height=990; const x=c.getContext('2d'); x.fillStyle='#ffffff'; x.fillRect(0,0,c.width,c.height); return c; }
function drawPdfHeader(x,title){ x.fillStyle='#173c33'; x.fillRect(0,0,1400,70); x.fillStyle='#ffffff'; x.font='bold 28px Arial'; x.fillText(title,34,45); x.fillStyle='#4b625b'; x.font='16px Arial'; x.fillText('Físico — Avelitrix',34,94); }
function makeSummaryPdfPage(){
  const c=makePageCanvas(),x=c.getContext('2d'); drawPdfHeader(x,'Resumo da atividade');
  const vals=[['Data',fmtDate(DATA.startTime)],['Duração',fmtDur(DATA.durationSec)],['Distância',((DATA.distanceM||0)/1000).toFixed(2)+' km'],['FC média',Math.round(DATA.avgHr||0)+' bpm'],['FC máxima',Math.round(DATA.maxHr||0)+' bpm'],['Calorias',String(DATA.calories??'—')]];
  vals.forEach((v,i)=>{const col=i%3,row=Math.floor(i/3),px=40+col*440,py=135+row*135;x.fillStyle='#eef3ef';x.strokeStyle='#bfcfc7';x.fillRect(px,py,405,105);x.strokeRect(px,py,405,105);x.fillStyle='#5a716a';x.font='16px Arial';x.fillText(v[0],px+18,py+30);x.fillStyle='#173c33';x.font='bold 28px Arial';x.fillText(v[1],px+18,py+72)});
  x.fillStyle='#173c33';x.font='bold 23px Arial';x.fillText('Zonas na atividade',40,445);
  const bounds=getZoneBounds(); let y=480; const total=(DATA.records||[]).length||1; for(let z=1;z<=5;z++){const count=(DATA.records||[]).filter(r=>zoneOf(r.hr)===z).length,pct=count/total*100;x.fillStyle=STATE_COLORS[z];x.fillRect(40,y,Math.max(4,pct*8),22);x.fillStyle='#173c33';x.font='16px Arial';x.fillText(`Zona ${z} · ${bounds[z]}–${bounds[z+1]} bpm · ${getZoneLabel(z)} · ${pct.toFixed(1)}%`,40,y-7);y+=78}
  return c;
}
function makeChartPdfPage(title,source){ const c=makePageCanvas(),x=c.getContext('2d');drawPdfHeader(x,title);if(source){const ratio=Math.min(1320/source.width,820/source.height);const w=source.width*ratio,h=source.height*ratio;x.drawImage(source,40,130,w,h)}return c; }
function makeTablePdfPages(title,table,rowsPerPage){
  const rows=[...table.querySelectorAll('tr')].map(tr=>[...tr.children].map(td=>td.innerText.trim())); if(!rows.length)return[];
  const header=rows[0],body=rows.slice(1),pages=[];
  for(let start=0;start<body.length;start+=rowsPerPage){const c=makePageCanvas(),x=c.getContext('2d');drawPdfHeader(x,title);const chunk=body.slice(start,start+rowsPerPage);const cols=header.length,colW=1320/cols;let y=130;x.fillStyle='#dfe9e4';x.fillRect(40,y,1320,34);x.fillStyle='#173c33';x.font='bold 13px Arial';header.forEach((v,i)=>x.fillText(trunc(v,18),44+i*colW,y+22));y+=34;x.font='12px Arial';chunk.forEach((row,ri)=>{x.fillStyle=ri%2?'#f3f6f4':'#ffffff';x.fillRect(40,y,1320,27);x.fillStyle='#263f38';row.forEach((v,i)=>x.fillText(trunc(v,18),44+i*colW,y+18));y+=27});pages.push(c)}return pages;
}
function trunc(s,n){s=String(s??'');return s.length>n?s.slice(0,n-1)+'…':s;}
function buildPdfFromCanvases(canvases){
  const enc=new TextEncoder(),objects=[],offsets=[0];
  const add=obj=>{objects.push(obj);return objects.length};
  const pageIds=[],imageIds=[];
  canvases.forEach(c=>{const bytes=dataUrlBytes(c.toDataURL('image/jpeg',0.88));const imgId=add({bin:bytes,head:`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,tail:'\nendstream'});imageIds.push(imgId)});
  const pagesId=add('PAGES_PLACEHOLDER');
  canvases.forEach((c,i)=>{const content=`q\n842 0 0 595 0 0 cm\n/Im${i+1} Do\nQ`;const contentId=add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);const pageId=add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 842 595] /Resources << /XObject << /Im${i+1} ${imageIds[i]} 0 R >> >> /Contents ${contentId} 0 R >>`);pageIds.push(pageId)});
  objects[pagesId-1]=`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id=>id+' 0 R').join(' ')}] >>`;
  const catalogId=add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const chunks=[enc.encode('%PDF-1.4\n%âãÏÓ\n')];let pos=chunks[0].length;
  objects.forEach((o,i)=>{offsets[i+1]=pos;const prefix=enc.encode(`${i+1} 0 obj\n`);chunks.push(prefix);pos+=prefix.length;if(typeof o==='string'){const b=enc.encode(o);chunks.push(b);pos+=b.length}else{const h=enc.encode(o.head);chunks.push(h);pos+=h.length;chunks.push(o.bin);pos+=o.bin.length;const t=enc.encode(o.tail);chunks.push(t);pos+=t.length}const end=enc.encode('\nendobj\n');chunks.push(end);pos+=end.length});
  const xref=pos;let table=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<=objects.length;i++)table+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';table+=`trailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  chunks.push(enc.encode(table));return new Blob(chunks,{type:'application/pdf'});
}
function dataUrlBytes(url){const b64=url.split(',')[1],bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}
function downloadBlob(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);}
function fmtFileDate(){ return new Date(DATA?.startTime || Date.now()).toISOString().slice(0,10); }
function download(name,text,mime){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:mime})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
