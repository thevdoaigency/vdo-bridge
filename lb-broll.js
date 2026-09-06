// lb-broll.js — AWC Bridge visual layer: PER-SHOT semantic b-roll search.
// Indexes each *.shotNN.visual.json (and legacy flat *.visual.json) as its own
// searchable moment, folding filename metadata (company/city/subject/date/method)
// into the embed text so generically-tagged shots still surface on contextual queries.
// Search: structured filters (city/company/date) + relative confidence floor + cap.
'use strict';

const http = require('http');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const r2 = require('./lb-r2');

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://127.0.0.1:11434';
const EMBED_MODEL  = process.env.LB_EMBED_MODEL || 'nomic-embed-text';
const INDEX_KEY    = process.env.LB_BROLL_INDEX || '_index/broll-embeddings.json';

const COMPANY = { LE:'Leopardo Efficiency', LC:'Leopardo Construction', GKE:'Grand Kahn Electric',
  LH:'Laystrom Hardware', EBT:'Enlyt Building Technologies', DFH:'DFH Connect', GP:'GATOR',
  LCI:'LCI Development Partners', AWC:'Alexander West Capital' };
const METHODS = ['Gimbal','Drone','HandHeld','Handheld','Tripod','Steadicam','Aerial'];

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}
async function getText(key) {
  const out = await r2.client().send(new GetObjectCommand({ Bucket: r2.BUCKET, Key: key }));
  return streamToString(out.Body);
}
function embed(text) {
  return new Promise((resolve, reject) => {
    const u = new URL(OLLAMA_URL);
    const payload = JSON.stringify({ model: EMBED_MODEL, prompt: text });
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: '/api/embeddings', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); j.embedding ? resolve(j.embedding) : reject(new Error('no embedding: ' + d.slice(0,200))); } catch (e) { reject(e); } });
    });
    req.setTimeout(60000, () => req.destroy(new Error('embed timeout')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}
function spaced(s){ return String(s).replace(/([a-z0-9])([A-Z])/g,'$1 $2'); }

// Derive structured metadata from the source clip filename stem.
function fileMeta(clip) {
  const stem = String(clip||'').replace(/\.mp4$/i,''); const p = stem.split('_');
  const yy = p[0]||''; let date='';
  if (/^\d{6}$/.test(yy)) date = '20'+yy.slice(0,2)+'-'+yy.slice(2,4)+'-'+yy.slice(4,6);
  const companyId = p[1]||''; const company = COMPANY[companyId] || companyId;
  const city = p[2]||'';
  const bi = p.findIndex(x=>/^broll$/i.test(x));
  let toks = bi>=0 ? p.slice(bi+1) : p.slice(4);
  let method='';
  if (toks.length && METHODS.includes(toks[toks.length-1])) method = toks.pop();
  const subject = spaced(toks.join(' '));
  return { date, companyId, company, city, subject, method };
}

// Embed text = filename context floor + per-shot vision specifics.
function embedText(tags) {
  const m = fileMeta(tags._source_clip);
  const parts = [];
  if (m.company) parts.push(m.company);
  if (m.city) parts.push(m.city);
  if (m.subject) parts.push(m.subject);
  if (m.method) parts.push(m.method + ' shot');
  if (tags.subject) parts.push(tags.subject);
  if (tags.action) parts.push(tags.action);
  if (tags.setting) parts.push(tags.setting);
  if (tags.shot_type) parts.push(tags.shot_type);
  if (Array.isArray(tags.equipment_visible)) parts.push(...tags.equipment_visible);
  const sb = tags.signage_or_branding;
  if (Array.isArray(sb)) parts.push(...sb.map(x=>(x&&(x.text||x.description))||'').filter(Boolean));
  else if (sb && typeof sb === 'object') parts.push(...Object.values(sb).filter(v=>typeof v==='string'));
  if (Array.isArray(tags.keywords)) parts.push(...tags.keywords);
  return parts.filter(Boolean).join(', ').replace(/\s+/g,' ');
}
function cosine(a, b) {
  let dot=0,na=0,nb=0;
  for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot/(Math.sqrt(na)*Math.sqrt(nb)||1);
}

// ── Index builder: one entry per shot sidecar ─────────────────────────────────
async function buildIndex(log = () => {}) {
  const keys = await r2.listAllKeys();
  const sidecars = keys.filter(k => /\.visual\.json$/i.test(k.key)); // matches .shotNN.visual.json and legacy flat
  log(`found ${sidecars.length} visual sidecars`);
  const entries = [];
  for (const { key } of sidecars) {
    let tags; try { tags = JSON.parse(await getText(key)); } catch (e) { log(`skip (bad json): ${key}`); continue; }
    const clip = tags._source_clip || key.replace(/\.(shot\d+\.)?visual\.json$/i, '.mp4').split('/').pop();
    const prefix = key.slice(0, key.lastIndexOf('/') + 1);
    const mp4Key = keys.find(k => k.key === prefix + clip)?.key || (prefix + clip);
    const text = embedText(tags);
    if (!text) { log(`skip (no text): ${key}`); continue; }
    const meta = fileMeta(clip);
    const vector = await embed(text);
    entries.push({
      clip, mp4Key, sidecarKey: key,
      company: tags._company || meta.companyId, companyName: meta.company,
      city: tags._city || meta.city, date: meta.date, method: meta.method,
      shotIndex: tags._shot_index || null,
      startTc: tags._shot_start_tc || null, endTc: tags._shot_end_tc || null,
      startFrame: tags._shot_start_frame ?? null, endFrame: tags._shot_end_frame ?? null,
      subject: tags.subject || null, action: tags.action || null,
      keywords: tags.keywords || [],
      vector,
    });
    log(`embedded ${clip}${tags._shot_index?(' shot'+tags._shot_index):''}`);
  }
  const index = { model: EMBED_MODEL, dims: entries[0]?.vector.length||0, built: new Date().toISOString(), count: entries.length, entries };
  await r2.client().send(new PutObjectCommand({ Bucket: r2.BUCKET, Key: INDEX_KEY, Body: JSON.stringify(index), ContentType: 'application/json' }));
  log(`wrote index: ${INDEX_KEY} (${entries.length} shots, ${index.dims}d)`);
  return { count: entries.length, dims: index.dims };
}

let _cache = null;
async function loadIndex(){ if(_cache) return _cache; _cache = JSON.parse(await getText(INDEX_KEY)); return _cache; }
function clearIndexCache(){ _cache = null; }

// GET /local-bridge/r2-broll?q=...&limit=12&city=Cleveland&company=LE&date=2026-07&floor=0.08
async function handleBrollSearch(req, res) {
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    const query = (q.get('q') || '').trim();
    const limit = Math.min(parseInt(q.get('limit') || '12', 10), 50);
    const fCity = (q.get('city') || '').trim().toLowerCase();
    const fCompany = (q.get('company') || '').trim().toLowerCase();
    const fDate = (q.get('date') || '').trim(); // prefix match e.g. 2026-07
    const margin = q.get('floor') != null ? parseFloat(q.get('floor')) : 0.08; // relative confidence floor
    if (!query) return sendJSON(res, 400, { ok:false, error:'q (query) required' });

    let index; try { index = await loadIndex(); }
    catch (e) { return sendJSON(res, 409, { ok:false, error:'No b-roll index yet — build it first (POST /local-bridge/r2-broll/reindex)' }); }

    // structured pre-filters (exact facts, not semantic)
    let pool = index.entries;
    if (fCity)    pool = pool.filter(e => (e.city||'').toLowerCase() === fCity);
    if (fCompany) {
      // supports a single code/name or a comma-separated allowlist (e.g. company=le,gke,awc)
      const wanted = fCompany.split(',').map(s => s.trim()).filter(Boolean);
      pool = pool.filter(e => wanted.some(w => (e.company||'').toLowerCase() === w || (e.companyName||'').toLowerCase().includes(w)));
    }
    if (fDate)    pool = pool.filter(e => (e.date||'').startsWith(fDate));
    if (!pool.length) return sendJSON(res, 200, { ok:true, query, count:0, results:[], note:'No shots match the filters.' });

    const qv = await embed(query);
    let ranked = pool.map(e => ({
      score: cosine(qv, e.vector),
      clip: e.clip, mp4Key: e.mp4Key, shotIndex: e.shotIndex,
      startTc: e.startTc, endTc: e.endTc, startFrame: e.startFrame, endFrame: e.endFrame,
      company: e.company, companyName: e.companyName, city: e.city, date: e.date, method: e.method,
      subject: e.subject, action: e.action, keywords: e.keywords,
      frameKey: e.sidecarKey ? e.sidecarKey.replace(/\.visual\.json$/i, ".frame.jpg") : null,
    })).sort((a,b)=>b.score-a.score);

    const top = ranked.length ? ranked[0].score : 0;
    const kept = ranked.filter(r => r.score >= top - margin);   // relative floor
    const totalStrong = kept.length;
    const results = kept.slice(0, limit);
    sendJSON(res, 200, {
      ok:true, query, count: results.length, totalMatches: totalStrong, indexBuilt: index.built,
      filters: { city:fCity||null, company:fCompany||null, date:fDate||null },
      note: totalStrong > results.length ? `Showing top ${results.length} of ${totalStrong} strong matches — add a city/date filter or be more specific to narrow.` : null,
      results,
    });
  } catch (err) { sendJSON(res, 500, { ok:false, error: err.message }); }
}

const reindexJobs = new Map();
function handleBrollReindex(req, res) {
  const jobId = Math.random().toString(16).slice(2,10);
  const job = { status:'running', startedAt:Date.now(), log:[], result:null, error:null };
  reindexJobs.set(jobId, job);
  (async () => {
    try { job.result = await buildIndex(m=>{ job.log.push(m); }); clearIndexCache(); job.status='done'; }
    catch (e) { job.error = e.message; job.status='error'; }
    job.finishedAt = Date.now();
  })();
  sendJSON(res, 200, { ok:true, jobId });
}
function handleBrollReindexStatus(req, res) {
  const id = new URL(req.url,'http://x').searchParams.get('id');
  const job = id && reindexJobs.get(id);
  if (!job) return sendJSON(res, 404, { ok:false, error:'unknown job' });
  sendJSON(res, 200, { status: job.status, elapsedSec: Math.round(((job.finishedAt||Date.now())-job.startedAt)/1000), result: job.result, error: job.error, tail: job.log.slice(-8) });
}


// GET /local-bridge/r2-broll/thumb?key=<...shotNN.frame.jpg>  — stream a shot thumbnail
async function handleBrollThumb(req, res) {
  try {
    const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
    if (!/\.frame\.jpg$/i.test(key)) { res.writeHead(400); res.end('bad key'); return; }
    const out = await r2.client().send(new GetObjectCommand({ Bucket: r2.BUCKET, Key: key }));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    out.Body.pipe(res);
  } catch (e) { res.writeHead(404); res.end('not found'); }
}

// GET /local-bridge/r2-reel?key=<COMPANY>/<stem>.mp4  — download a full b-roll master
async function handleReelDownload(req, res) {
  try {
    const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
    // Guards: mp4 only, must be b-roll (any casing: _Broll / _broll / _BRoll), no traversal
    if (!/\.mp4$/i.test(key) || !/_broll/i.test(key) || key.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad key');
    }
    const out = await r2.client().send(new GetObjectCommand({ Bucket: r2.BUCKET, Key: key }));
    const filename = key.split('/').pop();
    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"',
      'Access-Control-Allow-Origin': '*',
    };
    if (out.ContentLength != null) headers['Content-Length'] = out.ContentLength;
    res.writeHead(200, headers);
    out.Body.pipe(res);
    out.Body.on('error', () => res.destroy());
  } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
}

module.exports = { buildIndex, handleBrollSearch, handleBrollReindex, handleBrollReindexStatus, handleBrollThumb, handleReelDownload, embedText, fileMeta, cosine, INDEX_KEY };
