// lb-broll-cut.js — AWC Bridge: assemble selected b-roll SHOTS into an FCP7 XML.
// Each pick carries the shot's real in/out timecode (from scene detection), so the
// cut uses exact shot boundaries. Falls back to a first-N-seconds slice if a pick
// has no timecode (legacy). Output XML flows into the existing r2-render.
'use strict';

const { GetObjectCommand } = require('@aws-sdk/client-s3');
const r2 = require('./lb-r2');
const lb = require('./local-bridge'); // buildMultiSourceXml (exported)

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function parseBody(req, limitMB = 2) {
  return new Promise((resolve, reject) => {
    let body = ''; const limit = limitMB * 1024 * 1024;
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
async function getText(key) {
  const out = await r2.client().send(new GetObjectCommand({ Bucket: r2.BUCKET, Key: key }));
  return streamToString(out.Body);
}
function fpsFromXml(xml) {
  const tb = parseInt((xml.match(/<timebase>(\d+)<\/timebase>/) || [])[1] || '24', 10);
  const ntsc = /<ntsc>\s*TRUE\s*<\/ntsc>/i.test(xml);
  return ntsc ? (tb * 1000) / 1001 : tb;
}
function durFramesFromXml(xml) {
  return parseInt((xml.match(/<duration>(\d+)<\/duration>/) || [])[1] || '0', 10);
}
// "HH:MM:SS.mmm" (or "MM:SS.mmm") -> seconds
function tcToSec(tc) {
  if (typeof tc === 'number') return tc;
  if (!tc || typeof tc !== 'string') return null;
  const p = tc.split(':').map(Number);
  if (p.some(isNaN)) return null;
  let s = 0; for (const n of p) s = s * 60 + n;
  return s;
}

// Accepts picks as either:
//   - a plain stem string (legacy: first perShotSeconds of the clip), or
//   - { stem, startTc, endTc } (a specific shot -> exact in/out)
async function buildBrollCut(picks, perShotSeconds) {
  if (!Array.isArray(picks) || !picks.length) throw new Error('No shots selected');
  const per = Math.max(0.5, Math.min(parseFloat(perShotSeconds) || 3, 30));

  const keys = await r2.listAllKeys();
  const byStemXml = {};
  for (const { key } of keys) {
    if (/\.xml$/i.test(key) && !/\.visual\./i.test(key)) {
      const stem = key.split('/').pop().replace(/\.xml$/i, '');
      byStemXml[stem] = key;
    }
  }

  const sourceMap = {}, outPicks = [], missing = [];
  let idx = 0;
  for (const raw of picks) {
    const pick = typeof raw === 'string' ? { stem: raw } : (raw || {});
    const stem = (pick.stem || (pick.clip || '').replace(/\.mp4$/i, '') || (pick.mp4Key || '').split('/').pop().replace(/\.mp4$/i, ''));
    if (!stem) { continue; }
    const xmlKey = byStemXml[stem];
    if (!xmlKey) { missing.push(stem); continue; }

    // load source XML once per stem
    let src = sourceMap[stem];
    if (!src) {
      const xmlText = await getText(xmlKey);
      const fps = fpsFromXml(xmlText);
      const frames = durFramesFromXml(xmlText);
      const clipSecs = frames > 0 ? frames / fps : 9999;
      src = { xmlText, fps, clipSecs, transcript: { segments: [] } };
      sourceMap[stem] = src;
    }

    // shot range -> seconds, clamped to clip length
    let startSec = tcToSec(pick.startTc);
    let endSec   = tcToSec(pick.endTc);
    if (startSec == null || endSec == null || endSec <= startSec) {
      startSec = 0; endSec = Math.min(per, src.clipSecs - 0.05); // legacy fallback
    }
    startSec = Math.max(0, Math.min(startSec, src.clipSecs - 0.1));
    endSec   = Math.min(endSec, src.clipSecs - 0.02);
    const dur = Math.max(0.2, endSec - startSec);

    // one synthetic "word" per pick spanning the exact shot range
    const seg = src.transcript.segments.length;
    src.transcript.segments.push({ start: startSec, words: [{ text: 'shot', start: startSec, duration: dur }] });
    outPicks.push({ source_file: stem, seg, w_first: 0, w_last: 0, note: 'shot ' + startSec.toFixed(1) + '-' + endSec.toFixed(1) + 's' });
    idx++;
  }
  if (!outPicks.length) throw new Error('No b-roll XML found for selection: ' + missing.join(', '));

  // buildMultiSourceXml wants sourceMap entries as { xmlText, transcript }
  const sm = {};
  for (const k of Object.keys(sourceMap)) sm[k] = { xmlText: sourceMap[k].xmlText, transcript: sourceMap[k].transcript };

  const result = lb.buildMultiSourceXml(outPicks, sm, 'AWC B-roll Cut');
  result.summary.title = 'AWC B-roll Cut';
  result.summary.pickCount = outPicks.length;
  result.summary.shotAccurate = picks.some(p => typeof p === 'object' && p.startTc);
  result.summary.sources = Object.keys(sourceMap);
  result.summary.provider = 'broll-cut';
  if (missing.length) result.summary.skipped = missing;
  return result;
}

// POST /local-bridge/r2-broll-cut  { picks: [ {stem,startTc,endTc} | "stem" ], perShotSeconds }
// (also accepts legacy { stems: ["stem", ...] })
async function handleBrollCut(req, res) {
  try {
    const body = await parseBody(req);
    const picks = body.picks || body.stems || [];
    const result = await buildBrollCut(picks, body.perShotSeconds);
    sendJSON(res, 200, { ok: true, xml: result.xml, summary: result.summary });
  } catch (err) {
    console.error('b-roll cut error:', err.message);
    sendJSON(res, 500, { ok: false, error: err.message });
  }
}

module.exports = { buildBrollCut, handleBrollCut, tcToSec };
