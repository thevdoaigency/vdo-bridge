// lb-r2-render.js — AWC Bridge media broker + render.
// Pulls the source MP4s a cutdown references from R2 into a local cache,
// repoints the XML at the cached copies, then runs the existing xml-to-rough-cut.js.
// Reuses that render script untouched. Routes: start / status / download.
//
// Env (defaults shown):
//   LB_R2_CACHE       /home/vdoaigency/lb-media-cache   pulled source files (kept, reused)
//   LB_RENDER_DIR     /tmp/lb-renders                   job workspace + finished MP4s
//   LB_RENDER_SCRIPT  /home/vdoaigency/xml-to-rough-cut.js
//   LB_MAX_JOBS       2
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const r2 = require('./lb-r2');

const CACHE_DIR     = process.env.LB_R2_CACHE     || '/home/vdoaigency/lb-media-cache';
const RENDER_DIR    = process.env.LB_RENDER_DIR   || '/tmp/lb-renders';
const RENDER_SCRIPT = process.env.LB_RENDER_SCRIPT|| '/home/vdoaigency/xml-to-rough-cut.js';
const MAX_JOBS      = parseInt(process.env.LB_MAX_JOBS || '2', 10);
const MAX_BODY      = 20 * 1024 * 1024;
const CARD_SCRIPT   = process.env.LB_CARD_SCRIPT || path.join(__dirname, 'lt_gen.py');
const CARD_SCALE    = parseFloat(process.env.LB_CARD_SCALE || '2.0');
const WIPE_SEC      = parseFloat(process.env.LB_WIPE_SEC || '0.40');
const FADE_SEC      = parseFloat(process.env.LB_FADE_SEC || '0.40');
const DWELL_SEC     = parseFloat(process.env.LB_DWELL_SEC || '4.8');

for (const d of [CACHE_DIR, RENDER_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

const jobs = new Map();
function runningCount() { let n = 0; for (const j of jobs.values()) if (j.status === 'running') n++; return n; }

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(null));
}
function sanitizeName(name) {
  const base = String(name || 'rough_cut').replace(/\.mp4$/i, '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
  return (base || 'rough_cut') + '.mp4';
}

// Decode a <pathurl> to a plain path, same as the render script does.
function decodePathUrl(u) {
  if (!u) return null;
  let p = u.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '');
  try { p = decodeURIComponent(p); } catch (e) {}
  return p;
}

// ── Lower thirds ──────────────────────────────────────────────────────────────
// Derived entirely from the cutdown XML: interview stems carry Name (field 3)
// and Title (fields 4+), so each speaker's on-screen segments get an automatic
// branded lower third burned in by a second ffmpeg pass after the main render.
// B-roll clipitems (any _Broll_ token) produce no segments; a b-roll cut passes
// through untouched. If the overlay pass fails, the plain render ships instead.

// Brand tokens lifted from the AWC portfolio graphic builder so the burned-in
// thirds match the stills: a solid accent badge, uppercase near-black name,
// muted title underneath. `nameText`/`titleText` are the on-badge colours.
const BRANDS = {
  le:       { accent: '0xf5c800', nameText: '0x000000', titleText: '0x333333' }, // Leopardo Efficiency
  lc:       { accent: '0xf5c800', nameText: '0x000000', titleText: '0x333333' }, // Leopardo Construction
  gke:      { accent: '0x9A0000', nameText: '0xffffff', titleText: '0xe6e6e6' }, // Grand Kahn Electric
  awc:      { accent: '0xc9a84c', nameText: '0x111111', titleText: '0x333333' },
  vdo:      { accent: '0xe8b84b', nameText: '0x111111', titleText: '0x333333' },
  corniche: { accent: '0x9A7F45', nameText: '0xffffff', titleText: '0xe6e6e6' },
};

// Helvetica Now Display if present — either committed alongside this module
// (~/local-bridge/fonts) or installed system-wide — DejaVu otherwise.
const pickFont = (...paths) => paths.find(f => f && fs.existsSync(f));
const FONT_BOLD = pickFont(
  process.env.LB_FONT_BOLD,
  path.join(__dirname, 'fonts', 'HelveticaNowDisplay-Bold.ttf'),
  '/usr/local/share/fonts/HelveticaNowDisplay-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
const FONT_REG = pickFont(
  process.env.LB_FONT_REG,
  path.join(__dirname, 'fonts', 'HelveticaNowDisplay-Regular.ttf'),
  '/usr/local/share/fonts/HelveticaNowDisplay-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');

function spacedCaps(s) { return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2'); }

// Interview stem → { co, name, title }, or null for b-roll / malformed / unknown.
// `co` is the company code (field 1), which selects the brand palette — the AWC
// face carries several portfolio companies, so the brand is per speaker, not
// per page.
function speakerFromBase(base) {
  const stem = String(base || '').replace(/\.mp4$/i, '').replace(/_Bcam$/i, '');
  const p = stem.split('_');
  if (p.length < 5) return null;
  if (p.some(x => /^broll$/i.test(x))) return null;
  return { co: String(p[1] || '').toLowerCase(), name: spacedCaps(p[3]), title: spacedCaps(p.slice(4).join(' ')) };
}

// Parse timeline segments per speaker from the cutdown XML.
// Uses the sequence timebase (first <timebase> in the document); merges
// overlapping/adjacent same-speaker segments so two-cam angles dedupe.
function extractSpeakerSegments(xml) {
  const tb = xml.match(/<timebase>(\d+)<\/timebase>/);
  const fps = tb ? parseInt(tb[1], 10) : 30;
  const segs = [];
  const re = /<clipitem[^>]*>([\s\S]*?)<\/clipitem>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const c = m[1];
    const s = c.match(/<start>(-?\d+)<\/start>/);
    const e = c.match(/<end>(-?\d+)<\/end>/);
    const pu = c.match(/<pathurl>([\s\S]*?)<\/pathurl>/);
    if (!s || !e || !pu) continue;
    const start = parseInt(s[1], 10), end = parseInt(e[1], 10);
    if (start < 0 || end <= start) continue;
    const base = path.basename(decodePathUrl(pu[1].trim()) || '');
    const who = speakerFromBase(base);
    if (!who) continue;
    segs.push({ t0: start / fps, t1: end / fps, co: who.co, name: who.name, title: who.title });
  }
  segs.sort((a, b) => a.t0 - b.t0);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.name === s.name && s.t0 <= last.t1 + 0.5) last.t1 = Math.max(last.t1, s.t1);
    else merged.push({ ...s });
  }
  return merged;
}

function ffEsc(t) { return String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\\\'"); }

// Per speaker appearance: a solid accent badge holding the uppercase name,
// with the title in a muted tone directly beneath it. Badge width is estimated
// from the glyph count since ffmpeg can't measure text before drawing.
// Geometry mirrors the graphic builder's quote card, scaled for 1080p.
const LT = { x: 60, baseY: 150, nameSize: 34, titleSize: 20, padX: 22, padY: 14, titlePadY: 9, gap: 0, track: 2 };

function buildLowerThirdFilter(segs, fallback) {
  if (!FONT_BOLD || !FONT_REG) return '';
  const parts = [];
  for (const s of segs) {
    const brand = BRANDS[s.co] || fallback;   // company code wins over page default
    const show0 = s.t0 + 0.3, show1 = Math.min(s.t1 - 0.2, s.t0 + 4.8);
    if (show1 - show0 < 1) continue;
    const en = `enable='between(t,${show0.toFixed(2)},${show1.toFixed(2)})'`;
    const name = s.name.toUpperCase();
    // ~0.62em per glyph for Helvetica-ish caps, plus the letter-spacing we ask for.
    const badgeW = Math.round(name.length * (LT.nameSize * 0.62 + LT.track) + LT.padX * 2);
    const badgeH = LT.nameSize + LT.padY * 2;
    const badgeY = LT.baseY + badgeH;  // px up from the bottom edge
    parts.push(`drawbox=x=${LT.x}:y=ih-${badgeY}:w=${badgeW}:h=${badgeH}:color=${brand.accent}@1:t=fill:${en}`);
    parts.push(`drawtext=fontfile=${FONT_BOLD}:text='${ffEsc(name)}':x=${LT.x + LT.padX}:y=h-${badgeY - LT.padY}:fontsize=${LT.nameSize}:fontcolor=${brand.nameText}:${en}`);

    // Title sits in its own strip, left edge flush with the badge. The builder
    // puts dark title text on a light card; over footage that inverts to light
    // text on a scrim, which is the only way it stays readable on any shot.
    const title = s.title;
    const stripW = Math.round(title.length * LT.titleSize * 0.55 + LT.padX * 2);
    const stripH = LT.titleSize + LT.titlePadY * 2;
    // Y values count upward from the bottom edge. The badge's lower edge sits
    // at baseY, so the strip's top edge starts exactly there.
    const stripY = LT.baseY - LT.gap;
    parts.push(`drawbox=x=${LT.x}:y=ih-${stripY}:w=${stripW}:h=${stripH}:color=0x111111@0.82:t=fill:${en}`);
    parts.push(`drawtext=fontfile=${FONT_REG}:text='${ffEsc(title)}':x=${LT.x + LT.padX}:y=h-${stripY - LT.titlePadY}:fontsize=${LT.titleSize}:fontcolor=0xf2f2f2:${en}`);
  }
  return parts.join(',');
}

function spawnP(cmd, args, opts, appendLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    child.stdout && child.stdout.on('data', appendLog);
    child.stderr && child.stderr.on('data', appendLog);
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
}

// Run a command and capture stdout; resolves null on any failure so callers
// can fall back rather than dying.
function capture(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { return resolve(null); }
    child.stdout.on('data', b => { out += b.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 ? out.trim() : null));
  });
}

// The card is sized from the real frame, so vertical or 4K deliveries keep
// their proportions instead of inheriting 1080p pixel values.
async function probeVideo(file) {
  const out = await capture('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0:s=x', file]);
  if (!out) return null;
  const [w, h, rate] = out.split('x');
  const [num, den] = String(rate || '25/1').split('/');
  const fps = (parseFloat(num) / parseFloat(den || '1')) || 25;
  const W = parseInt(w, 10), H = parseInt(h, 10);
  if (!W || !H) return null;
  return { w: W, h: H, fps };
}

// One PNG per distinct speaker, cropped tight to its content. Tight cards keep
// the wipe mask small, which is where the render cost lives.
async function makeCard(seg, brand, dir, W, H, idx) {
  const png = path.join(dir, `lt_${idx}.png`);
  const out = await capture('python3', [CARD_SCRIPT, png,
    '--name', seg.name, '--title', seg.title || '',
    '--accent', brand.accent.replace(/^0x/, ''),
    '--name-text', brand.nameText.replace(/^0x/, ''),
    '--w', String(W), '--h', String(H), '--scale', String(CARD_SCALE)]);
  if (!out) return null;
  const [x, y, cw, ch] = out.split(/\s+/).map(n => parseInt(n, 10));
  if (![x, y, cw, ch].every(Number.isFinite) || !fs.existsSync(png)) return null;
  return { png, x, y, w: cw, h: ch };
}

// Turn speaker segments into cards + on/off timings. Cards are cached per
// speaker so a person appearing five times costs one PNG, not five.
async function planShots(segs, fallback, dir, W, H, log) {
  const cache = new Map();
  const shots = [];
  for (const seg of segs) {
    const on = seg.t0 + 0.3;
    const off = Math.min(seg.t1 - 0.2, seg.t0 + DWELL_SEC);
    if (off - on < WIPE_SEC + 0.3) continue;   // too brief to animate cleanly
    const brand = BRANDS[seg.co] || fallback;
    const key = `${seg.co}|${seg.name}|${seg.title}`;
    if (!cache.has(key)) {
      const card = await makeCard(seg, brand, dir, W, H, cache.size);
      if (!card) { log(`\ncard render failed for ${seg.name}`); return null; }
      cache.set(key, card);
    }
    shots.push({ card: cache.get(key), on, off });
  }
  return shots;
}

// Build the ffmpeg args for the overlay pass. Each appearance gets a small
// black/white mask whose white slab slides right; multiplying it into the
// card's own alpha gives a true left-to-right wipe that respects the shadow.
// drawbox can't do this (in its expressions `t` is thickness, not time) and geq
// can but runs ~10x realtime. Sliding an overlay is the cheap way to animate.
function buildThirdsArgs(intermediate, shots, outPath) {
  const args = ['-y', '-i', intermediate];
  for (const s of shots) args.push('-loop', '1', '-i', s.card.png);

  const chains = [];
  let prev = '0:v';
  shots.forEach((s, i) => {
    const cw = s.card.w, ch = s.card.h;
    const spd = (cw / WIPE_SEC).toFixed(2);
    const on = s.on.toFixed(2);
    const off = s.off.toFixed(2);
    const fadeAt = Math.max(s.on + WIPE_SEC, s.off - FADE_SEC).toFixed(2);
    chains.push(
      `color=c=black:s=${cw}x${ch}:r=25[mb${i}]`,
      `color=c=white:s=${cw}x${ch}:r=25[mw${i}]`,
      // min(0,...) parks the slab once it's fully revealed — without the clamp
      // it keeps travelling and the mask goes black again mid-shot.
      `[mb${i}][mw${i}]overlay=x='min(0,-${cw}+max(0,(t-${on})*${spd}))':y=0[m${i}]`,
      `[${i + 1}:v]format=rgba,split[c${i}][a${i}]`,
      `[a${i}]alphaextract[ca${i}]`,
      `[ca${i}][m${i}]blend=all_mode=multiply[am${i}]`,
      `[c${i}][am${i}]alphamerge,fade=t=out:st=${fadeAt}:d=${FADE_SEC}:alpha=1[lt${i}]`,
      `[${prev}][lt${i}]overlay=${s.card.x}:${s.card.y}:enable='between(t,${on},${off})'[v${i}]`
    );
    prev = `v${i}`;
  });

  args.push('-filter_complex', chains.join(';'),
    '-map', `[${prev}]`, '-map', '0:a?',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-c:a', 'copy',
    '-shortest', outPath);
  return args;
}

// Pull every distinct source basename referenced by the cutdown XML.
function extractBasenames(xml) {
  const set = new Set();
  const re = /<pathurl>([\s\S]*?)<\/pathurl>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const p = decodePathUrl(m[1].trim());
    if (p) set.add(path.basename(p));
  }
  return [...set];
}

// Rewrite every <pathurl> so its basename points at the local cache copy.
function repointXml(xml, baseToLocal) {
  return xml.replace(/<pathurl>([\s\S]*?)<\/pathurl>/g, (full, inner) => {
    const p = decodePathUrl(inner.trim());
    const base = p ? path.basename(p) : null;
    const local = base && baseToLocal[base];
    if (!local) return full;
    return '<pathurl>file://localhost' + local + '</pathurl>';
  });
}

async function downloadToCache(key, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) return 'cached';
  const out = await r2.client().send(new GetObjectCommand({ Bucket: r2.BUCKET, Key: key }));
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    out.Body.pipe(ws);
    out.Body.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
  });
  return 'pulled';
}

// Build basename → R2 key map (mp4s only), resolve the ones this cut needs.
async function resolveAndPull(basenames, job) {
  const keys = await r2.listAllKeys();
  const byBase = {};
  for (const { key } of keys) if (/\.mp4$/i.test(key)) byBase[path.basename(key)] = key;

  const baseToLocal = {};
  const missing = [];
  for (const base of basenames) {
    const key = byBase[base];
    if (!key) { missing.push(base); continue; }
    const dest = path.join(CACHE_DIR, base);
    job.logTail += `\nresolving ${base} → ${key}`;
    const how = await downloadToCache(key, dest);
    job.logTail = (job.logTail + ` [${how}]`).slice(-4000);
    baseToLocal[base] = dest;
  }
  return { baseToLocal, missing };
}

// POST /local-bridge/r2-render  { xml, name }
function handleLBR2RenderStart(req, res) {
  readBody(req, (raw) => {
    if (!raw) return sendJson(res, 400, { ok: false, error: 'Empty or oversized request body' });
    let xml, name, brand;
    try { const p = JSON.parse(raw); xml = p.xml; name = p.name; brand = p.brand; } catch (e) { xml = raw; }
    if (!xml || typeof xml !== 'string' || xml.indexOf('<xmeml') === -1)
      return sendJson(res, 400, { ok: false, error: 'Body must contain a Premiere FCP7 XML (missing <xmeml>)' });
    if (runningCount() >= MAX_JOBS) return sendJson(res, 429, { ok: false, error: 'Render queue full — try again shortly' });
    if (!fs.existsSync(RENDER_SCRIPT)) return sendJson(res, 500, { ok: false, error: 'Render script not found at ' + RENDER_SCRIPT });

    const jobId  = crypto.randomBytes(4).toString('hex');
    const jobDir = path.join(RENDER_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const outName = sanitizeName(name);
    const outPath = path.join(jobDir, outName);

    const job = { id: jobId, status: 'running', name: outName, startedAt: Date.now(), finishedAt: null, outPath, logTail: '', exitCode: null };
    jobs.set(jobId, job);

    (async () => {
      try {
        const bases = extractBasenames(xml);
        if (!bases.length) throw new Error('No <pathurl> sources found in XML');
        const { baseToLocal, missing } = await resolveAndPull(bases, job);
        if (missing.length) throw new Error('Sources not in R2: ' + missing.join(', '));

        const repointed = repointXml(xml, baseToLocal);
        const xmlPath = path.join(jobDir, 'cutdown.xml');
        fs.writeFileSync(xmlPath, repointed, 'utf8');

        // Lower thirds: only when the page names a known brand AND the cut
        // contains interview speakers. Otherwise render exactly as before.
        const brandCfg = brand && BRANDS[String(brand).toLowerCase()];
        const segs = brandCfg ? extractSpeakerSegments(repointed) : [];
        const wantThirds = segs.length > 0;
        const renderTarget = wantThirds ? path.join(jobDir, 'raw_' + outName) : outPath;

        const appendLog = (b) => { job.logTail = (job.logTail + b.toString('utf8')).slice(-4000); };
        const log = (m) => { job.logTail = (job.logTail + m).slice(-4000); };
        const code = await spawnP('node', [RENDER_SCRIPT, xmlPath, renderTarget], { cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'] }, appendLog);
        if (code !== 0 || !fs.existsSync(renderTarget) || !fs.statSync(renderTarget).size) {
          job.exitCode = code; job.status = 'error'; job.finishedAt = Date.now(); return;
        }

        if (wantThirds) {
          log(`\nlower thirds: ${segs.length} speaker segment(s), brand=${brand}`);

          // Preferred path: animated card overlays sized from the real frame.
          // Falls back to the static inline draw if Python/Pillow or ffprobe
          // aren't available, and to a plain render if that fails too — a cut
          // without thirds always beats a failed job.
          let ffCode = 1;
          const meta = await probeVideo(renderTarget);
          if (meta) {
            const shots = await planShots(segs, brandCfg, jobDir, meta.w, meta.h, log);
            if (shots && shots.length) {
              log(`\ncards: ${shots.length} appearance(s) at ${meta.w}x${meta.h}, wipe ${WIPE_SEC}s`);
              ffCode = await spawnP('ffmpeg', buildThirdsArgs(renderTarget, shots, outPath),
                { cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'] }, appendLog);
            }
          }

          if (ffCode !== 0) {
            log('\ncard pass unavailable — falling back to static thirds');
            const filter = buildLowerThirdFilter(segs, brandCfg);
            if (filter) {
              ffCode = await spawnP('ffmpeg', ['-y', '-i', renderTarget, '-vf', filter,
                '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-c:a', 'copy', outPath],
                { cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'] }, appendLog);
            }
          }

          if (ffCode !== 0 || !fs.existsSync(outPath) || !fs.statSync(outPath).size) {
            log('\nlower-third pass failed — shipping plain render');
            fs.renameSync(renderTarget, outPath);
          } else {
            fs.unlinkSync(renderTarget);
          }
        }

        job.exitCode = 0;
        job.finishedAt = Date.now();
        job.status = (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) ? 'done' : 'error';
      } catch (err) {
        job.status = 'error'; job.finishedAt = Date.now();
        job.logTail = (job.logTail + '\n' + err.message).slice(-4000);
      }
    })();

    console.log('LB R2 render started:', jobId, outName);
    sendJson(res, 200, { ok: true, jobId });
  });
}

function handleLBR2RenderStatus(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id'); const job = id && jobs.get(id);
  if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job id' });
  const out = { ok: true, status: job.status, name: job.name, elapsedSec: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000) };
  if (job.status === 'done')  out.sizeBytes = fs.statSync(job.outPath).size;
  if (job.status === 'error') out.log = job.logTail.slice(-1500);
  sendJson(res, 200, out);
}

function handleLBR2RenderDownload(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id'); const job = id && jobs.get(id);
  if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job id' });
  if (job.status === 'running') return sendJson(res, 409, { ok: false, error: 'Still rendering' });
  if (job.status !== 'done') return sendJson(res, 500, { ok: false, error: 'Render failed', log: job.logTail.slice(-1500) });
  const stat = fs.statSync(job.outPath);
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Content-Disposition': 'attachment; filename="' + job.name + '"' });
  fs.createReadStream(job.outPath).pipe(res);
}

module.exports = { handleLBR2RenderStart, handleLBR2RenderStatus, handleLBR2RenderDownload, extractBasenames, repointXml };
