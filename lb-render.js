// lb-render.js — Local Bridge Render: XML → rough-cut MP4 on the GX10
// Companion module to local-bridge.js. Shells out to xml-to-rough-cut.js + FFmpeg.
// Matches the raw http style used by server.js / local-bridge.js. No cloud calls.
// Routes exposed: handleLBRenderStart, handleLBRenderStatus, handleLBRenderDownload
//
// Env (all optional, defaults shown):
//   LB_MEDIA_ROOT    /home/vdoaigency/lb-media        where the source library lives on the GX10
//   LB_REMAP_FROM    /Volumes/thevdoaigency           path prefix inside the cutdown XML pathurls
//   LB_RENDER_DIR    /tmp/lb-renders                  job workspace + finished MP4s
//   LB_RENDER_SCRIPT /home/vdoaigency/xml-to-rough-cut.js
//   LB_MAX_JOBS      2                                concurrent renders allowed

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { spawn } = require('child_process');

const MEDIA_ROOT    = process.env.LB_MEDIA_ROOT    || '/home/vdoaigency/lb-media';
const REMAP_FROM    = process.env.LB_REMAP_FROM    || '/Volumes/thevdoaigency';
const RENDER_DIR    = process.env.LB_RENDER_DIR    || '/tmp/lb-renders';
const RENDER_SCRIPT = process.env.LB_RENDER_SCRIPT || '/home/vdoaigency/xml-to-rough-cut.js';
const MAX_JOBS      = parseInt(process.env.LB_MAX_JOBS || '2', 10);
const MAX_BODY      = 20 * 1024 * 1024; // 20MB — cutdown XMLs are small, this is generous

if (!fs.existsSync(RENDER_DIR)) fs.mkdirSync(RENDER_DIR, { recursive: true });

// ── In-memory job table ──────────────────────────────────────────────────────
// { id: { status, name, startedAt, finishedAt, outPath, logTail, exitCode } }
const jobs = new Map();

function runningCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'running') n++;
  return n;
}

function sanitizeName(name) {
  const base = String(name || 'rough_cut')
    .replace(/\.mp4$/i, '')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 80);
  return (base || 'rough_cut') + '.mp4';
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(null));
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ── POST /local-bridge/render ────────────────────────────────────────────────
// Body: JSON { xml: "<full cutdown XML string>", name: "blake_health_RR1" }
// Returns: { ok: true, jobId: "a1b2c3d4" }
function handleLBRenderStart(req, res) {
  readBody(req, (raw) => {
    if (!raw) return sendJson(res, 400, { ok: false, error: 'Empty or oversized request body' });

    let xml, name;
    try {
      const parsed = JSON.parse(raw);
      xml  = parsed.xml;
      name = parsed.name;
    } catch (e) {
      // Allow raw XML posted directly (Content-Type: application/xml)
      xml = raw;
    }

    if (!xml || typeof xml !== 'string' || xml.indexOf('<xmeml') === -1) {
      return sendJson(res, 400, { ok: false, error: 'Body must contain a Premiere FCP7 XML (missing <xmeml>)' });
    }

    if (runningCount() >= MAX_JOBS) {
      return sendJson(res, 429, { ok: false, error: 'Render queue full — try again in a few minutes' });
    }

    if (!fs.existsSync(RENDER_SCRIPT)) {
      return sendJson(res, 500, { ok: false, error: 'Render script not found at ' + RENDER_SCRIPT });
    }
    if (!fs.existsSync(MEDIA_ROOT)) {
      return sendJson(res, 500, { ok: false, error: 'Media root not found at ' + MEDIA_ROOT });
    }

    const jobId   = crypto.randomBytes(4).toString('hex');
    const jobDir  = path.join(RENDER_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const outName = sanitizeName(name);
    const xmlPath = path.join(jobDir, 'cutdown.xml');
    const outPath = path.join(jobDir, outName);
    fs.writeFileSync(xmlPath, xml, 'utf8');

    const remapArg = REMAP_FROM + '=' + MEDIA_ROOT;
    const child = spawn('node', [RENDER_SCRIPT, xmlPath, outPath, '--remap', remapArg], {
      cwd: jobDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const job = {
      id: jobId,
      status: 'running',
      name: outName,
      startedAt: Date.now(),
      finishedAt: null,
      outPath,
      logTail: '',
      exitCode: null,
    };
    jobs.set(jobId, job);

    const appendLog = (buf) => {
      job.logTail = (job.logTail + buf.toString('utf8')).slice(-4000); // keep last 4KB
    };
    child.stdout.on('data', appendLog);
    child.stderr.on('data', appendLog);

    child.on('error', (err) => {
      job.status = 'error';
      job.finishedAt = Date.now();
      job.logTail += '\nSpawn error: ' + err.message;
    });

    child.on('close', (code) => {
      job.exitCode = code;
      job.finishedAt = Date.now();
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        job.status = 'done';
      } else {
        job.status = 'error';
      }
    });

    console.log('LB render started:', jobId, outName);
    sendJson(res, 200, { ok: true, jobId });
  });
}

// ── GET /local-bridge/render/status?id=xxxx ──────────────────────────────────
// Returns: { ok, status: running|done|error, name, elapsedSec, sizeBytes?, log? }
function handleLBRenderStatus(req, res) {
  const q  = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id');
  const job = id && jobs.get(id);
  if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job id' });

  const out = {
    ok: true,
    status: job.status,
    name: job.name,
    elapsedSec: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000),
  };
  if (job.status === 'done')  out.sizeBytes = fs.statSync(job.outPath).size;
  if (job.status === 'error') out.log = job.logTail.slice(-1500);
  sendJson(res, 200, out);
}

// ── GET /local-bridge/render/download?id=xxxx ────────────────────────────────
// Streams the finished MP4.
function handleLBRenderDownload(req, res) {
  const q  = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id');
  const job = id && jobs.get(id);
  if (!job)                    return sendJson(res, 404, { ok: false, error: 'Unknown job id' });
  if (job.status === 'running') return sendJson(res, 409, { ok: false, error: 'Still rendering' });
  if (job.status !== 'done')    return sendJson(res, 500, { ok: false, error: 'Render failed', log: job.logTail.slice(-1500) });

  const stat = fs.statSync(job.outPath);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': stat.size,
    'Content-Disposition': 'attachment; filename="' + job.name + '"',
  });
  fs.createReadStream(job.outPath).pipe(res);
}

module.exports = { handleLBRenderStart, handleLBRenderStatus, handleLBRenderDownload };
