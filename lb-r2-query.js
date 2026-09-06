// lb-r2-query.js — AWC Bridge: generate a narrative cut sourcing transcripts from R2.
// Mirrors local-bridge.js's query flow, but loads each selected pair's .xml + .json
// straight from the awc-library bucket instead of local disk. Reuses the proven
// generatePicks + buildMultiSourceXml from local-bridge.js. No local library needed.
'use strict';

const { randomUUID } = require('crypto');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const r2 = require('./lb-r2');
const lb = require('./local-bridge'); // generatePicks, buildMultiSourceXml (exported)

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function parseBody(req, limitMB = 5) {
  return new Promise((resolve, reject) => {
    let body = '';
    const limit = limitMB * 1024 * 1024;
    req.on('data', c => { body += c; if (body.length > limit) { req.destroy(); reject(new Error('Payload too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function getObjectText(key) {
  const out = await r2.client().send(new GetObjectCommand({ Bucket: r2.BUCKET, Key: key }));
  return streamToString(out.Body);
}

// Resolve selected stems → { xmlText, transcript } by pulling both sidecars from R2.
async function loadPairsFromR2(stems) {
  const lib = await r2.listLibrary();
  const byStem = {};
  for (const it of lib) byStem[it.stem] = it;

  const sourceMap = {};
  const transcriptMap = {};
  const missing = [];
  for (const stem of stems) {
    const it = byStem[stem];
    if (!it || !it.keys.xml || !it.keys.json) { missing.push(stem); continue; }
    const [xmlText, jsonText] = await Promise.all([getObjectText(it.keys.xml), getObjectText(it.keys.json)]);
    let transcript;
    try { transcript = JSON.parse(jsonText); } catch (e) { missing.push(stem + ' (bad json)'); continue; }
    sourceMap[stem] = { xmlText, transcript };
    transcriptMap[stem] = transcript;
  }
  return { sourceMap, transcriptMap, missing };
}

// ── Job table (long generates can't hold an HTTP request open) ────────────────
const jobs = new Map();
const TTL = 60 * 60 * 1000;
function prune() { const now = Date.now(); for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > TTL) jobs.delete(id); }

// generatePicks with one automatic retry: empty/malformed pick responses from the
// local model are common on short, meta-phrased briefs; a single nudged re-ask
// converts most of them. Anything else rethrows untouched.
async function generatePicksWithRetry(transcriptMap, brief, target) {
  try {
    return await lb.generatePicks(transcriptMap, brief, target);
  } catch (err) {
    if (!/picks/i.test(err.message || '')) throw err;
    console.warn('LB R2 query: no/invalid picks ("' + err.message + '") — retrying once with nudge');
    const nudged = brief +
      '\n\nIMPORTANT: Your previous response was invalid or contained no picks. ' +
      'You MUST respond with valid JSON containing a non-empty "picks" array. ' +
      'Select at least one complete passage from the transcript, keeping each pick ' +
      'aligned to the transcript segment boundaries. If the requested duration is very short, ' +
      'return the single segment that best matches the brief.';
    return await lb.generatePicks(transcriptMap, nudged, target);
  }
}

// POST /local-bridge/r2-query  { brief, targetMinutes, selectedFiles: [stem, ...] }
async function handleLBR2Query(req, res) {
  try {
    const body = await parseBody(req);
    const { brief, targetMinutes, selectedFiles } = body;
    const wholeInterview = body.wholeInterview === true;
    if ((!brief && !wholeInterview) || !Array.isArray(selectedFiles) || !selectedFiles.length) {
      sendJSON(res, 400, { ok: false, error: 'brief and selectedFiles required' }); return;
    }

    const { sourceMap, transcriptMap, missing } = await loadPairsFromR2(selectedFiles);
    if (!Object.keys(sourceMap).length) {
      sendJSON(res, 400, { ok: false, error: 'No valid R2 pairs found for selection: ' + missing.join(', ') }); return;
    }

    const target = parseFloat(targetMinutes) || 1;
    prune();
    const jobId = randomUUID().slice(0, 8);
    const job = { id: jobId, status: 'running', startedAt: Date.now(), finishedAt: null, result: null, error: null };
    jobs.set(jobId, job);
    console.log('LB R2 query started:', jobId, '(' + Object.keys(sourceMap).length + ' sources from R2)');

    (async () => {
      try {
        let picksData, seqName;
        if (wholeInterview) {
          // Deterministic: every transcript segment becomes a pick, in selection order.
          const picks = [];
          for (const stem of selectedFiles) {
            const t = transcriptMap[stem];
            if (!t || !Array.isArray(t.segments)) continue;
            t.segments.forEach((seg, i) => {
              if (seg && Array.isArray(seg.words) && seg.words.length) {
                picks.push({ source_file: stem, seg: i, w_first: 0, w_last: seg.words.length - 1, note: 'full segment' });
              }
            });
          }
          picksData = { picks };
          seqName = (selectedFiles.length === 1 ? selectedFiles[0] : 'Selected Interviews') + ' - FULL';
        } else {
          picksData = await generatePicksWithRetry(transcriptMap, brief, target);
          seqName = picksData.title || 'AWC Bridge Cutdown';
        }
        const result = lb.buildMultiSourceXml(picksData.picks, sourceMap, seqName);
        result.summary.title        = seqName;
        result.summary.pickCount     = picksData.picks.length;
        if (wholeInterview) result.summary.model = 'whole interview (no model)';
        result.summary.targetSeconds = target * 60;
        result.summary.targetMinutes = target;
        result.summary.sources       = Object.keys(sourceMap);
        result.summary.provider      = 'ollama-local';
        if (missing.length) result.summary.skipped = missing;
        job.result = result;
        job.status = 'done';
      } catch (err) {
        console.error('LB R2 query job error:', jobId, err.message);
        console.error('LB R2 query job context:', jobId, 'sources=' + Object.keys(sourceMap).join(',') + ' target=' + target + 'min brief=' + JSON.stringify(String(brief).slice(0, 200)));
        job.error = err.message;
        job.status = 'error';
      }
      job.finishedAt = Date.now();
    })();

    sendJSON(res, 200, { ok: true, jobId });
  } catch (err) {
    console.error('LB R2 query error:', err);
    sendJSON(res, 500, { ok: false, error: err.message });
  }
}

// GET /local-bridge/r2-query/status?id=xxxx
function handleLBR2QueryStatus(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id');
  const job = id && jobs.get(id);
  if (!job) { sendJSON(res, 404, { ok: false, error: 'Unknown query job id' }); return; }
  const elapsedSec = Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);
  if (job.status === 'running') { sendJSON(res, 200, { status: 'running', elapsedSec }); return; }
  if (job.status === 'error')   { sendJSON(res, 200, { status: 'error', elapsedSec, error: job.error }); return; }
  sendJSON(res, 200, { status: 'done', elapsedSec, result: job.result });
}

module.exports = { handleLBR2Query, handleLBR2QueryStatus };
