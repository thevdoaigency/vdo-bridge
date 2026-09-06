// local-bridge.js — Local Bridge: multi-interview transcript query engine for VDO Aigency
// Ollama-only fork of Semantic Bridge. Runs on the GX10 against local models. No cloud calls.
// Matches the raw http style used by server.js / cutdown.js
// Routes exposed: serveLocalBridgePage, handleLBUpload, handleLBLibrary, handleLBQuery

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { IncomingForm } = require('formidable');

// ── Local LLM (Ollama) config — this tool is Ollama-only by design ───────────
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder-next:latest';
const OLLAMA_NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10);

const http = require('http');

// Library lives in /tmp/lb-library — separate from Semantic Bridge's sb-library
const LIBRARY_DIR = process.env.LB_LIBRARY_DIR || path.join(process.env.HOME || '/home/vdoaigency', 'lb-library');
if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// Plain-HTTP POST for local Ollama (no TLS on localhost/LAN)
function httpPostJson(baseUrl, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const payload = JSON.stringify(body);
    const options = {
      hostname: u.hostname,
      port: u.port || 80,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    // Local inference on big transcripts can take minutes — don't let default timeouts kill it
    req.setTimeout(15 * 60 * 1000, () => { req.destroy(new Error('Ollama request timed out (15m)')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseBody(req, limitMB = 50) {
  return new Promise((resolve, reject) => {
    let body = '';
    const limit = limitMB * 1024 * 1024;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { req.destroy(); reject(new Error('Payload too large')); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

// ── Library helpers ───────────────────────────────────────────────────────────

function projectDir(project) {
  // Sanitise project name for filesystem
  const safe = project.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_');
  const dir = path.join(LIBRARY_DIR, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listLibrary() {
  const projects = [];
  if (!fs.existsSync(LIBRARY_DIR)) return projects;
  for (const proj of fs.readdirSync(LIBRARY_DIR)) {
    const dir = path.join(LIBRARY_DIR, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir);
    const pairs = [];
    const xmlFiles = files.filter(f => f.toLowerCase().endsWith('.xml'));
    for (const xml of xmlFiles) {
      const base = xml.replace(/\.xml$/i, '');
      const jsonFile = files.find(f => f.toLowerCase() === base.toLowerCase() + '.json' || f.replace(/\.json$/i,'').toLowerCase() === base.toLowerCase());
      pairs.push({ name: base, xml: !!xml, json: !!jsonFile });
    }
    projects.push({ project: proj.replace(/_/g, ' '), dir: proj, pairs });
  }
  return projects;
}

// ── XML helpers (from cutdown.js) ─────────────────────────────────────────────

const TICKS_PER_SECOND = 254016000000n;

function childByTag(parent, tag) {
  if (!parent) return null;
  for (const c of parent.childNodes) if (c.nodeType === 1 && c.tagName === tag) return c;
  return null;
}
function childrenByTag(parent, tag) {
  const out = [];
  if (!parent) return out;
  for (const c of parent.childNodes) if (c.nodeType === 1 && c.tagName === tag) out.push(c);
  return out;
}
function detectFps(rateElem) {
  const tb = childByTag(rateElem, 'timebase');
  const ntsc = childByTag(rateElem, 'ntsc');
  const timebase = parseInt(tb.textContent);
  const isNtsc = ntsc && ntsc.textContent.trim().toUpperCase() === 'TRUE';
  return isNtsc ? (timebase * 1000) / 1001 : timebase;
}
function fpsToPproTicks(fps) {
  const fpsScaled = BigInt(Math.round(fps * 1e9));
  return (TICKS_PER_SECOND * 1000000000n + fpsScaled / 2n) / fpsScaled;
}

function indexSourceTracks(srcSeq) {
  const tracks = {};
  const media = childByTag(srcSeq, 'media');
  if (!media) return tracks;
  for (const [kind, prefix] of [['video','V'],['audio','A']]) {
    const sect = childByTag(media, kind);
    if (!sect) continue;
    childrenByTag(sect, 'track').forEach((tr, i) => {
      const clips = childrenByTag(tr, 'clipitem').map(ci => ({
        start: parseInt(childByTag(ci,'start').textContent),
        end:   parseInt(childByTag(ci,'end').textContent),
        elem:  ci,
      }));
      tracks[prefix + (i+1)] = clips;
    });
  }
  return tracks;
}

function buildFileDefRegistry(doc) {
  const registry = {};
  const allFiles = doc.getElementsByTagName('file');
  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    const fid = f.getAttribute('id');
    if (!fid) continue;
    const hasChildren = Array.from(f.childNodes).some(n => n.nodeType === 1);
    if (hasChildren && !(fid in registry)) registry[fid] = f;
  }
  return registry;
}

// ── Multi-source XML assembly ─────────────────────────────────────────────────
// picks now include { seg, w_first, w_last, note, source_file }
// sourceMap: { [source_file]: { xmlText, transcript } }

function buildMultiSourceXml(picks, sourceMap, sequenceName) {
  if (!picks.length) throw new Error('No picks to assemble');

  // Use the first source XML as the template for the output sequence
  const firstSourceFile = picks[0].source_file;
  const firstSource = sourceMap[firstSourceFile];
  if (!firstSource) throw new Error('Source not found: ' + firstSourceFile);

  let templateXml = firstSource.xmlText;
  if (templateXml.charCodeAt(0) === 0xFEFF) templateXml = templateXml.slice(1);

  const templateDoc = new DOMParser().parseFromString(templateXml, 'text/xml');
  const templateSeq = templateDoc.getElementsByTagName('sequence')[0];
  if (!templateSeq) throw new Error('No <sequence> in template XML');

  const fps = detectFps(childByTag(templateSeq, 'rate'));
  const pproTicks = fpsToPproTicks(fps);

  // Parse all source docs
  const parsedSources = {};
  for (const [srcFile, src] of Object.entries(sourceMap)) {
    let xmlText = src.xmlText;
    if (xmlText.charCodeAt(0) === 0xFEFF) xmlText = xmlText.slice(1);
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const seq = doc.getElementsByTagName('sequence')[0];
    if (!seq) continue;
    parsedSources[srcFile] = {
      doc,
      seq,
      tracks: indexSourceTracks(seq),
      fileReg: buildFileDefRegistry(doc),
      transcript: src.transcript,
    };
  }

  // Build per-track clip list across all sources
  const perTrack = {};
  let cursor = 0;

  for (const pick of picks) {
    const src = parsedSources[pick.source_file];
    if (!src) continue;
    const transcript = src.transcript;
    const seg = transcript.segments[pick.seg];
    if (!seg || !seg.words) continue;
    const w0 = seg.words[pick.w_first];
    const wN = seg.words[pick.w_last];
    if (!w0 || !wN) continue;
    const secIn  = w0.start;
    const secOut = wN.start + wN.duration;
    const origSeqIn  = Math.round(secIn  * fps);
    const origSeqOut = Math.round(secOut * fps);
    const dur = origSeqOut - origSeqIn;
    if (dur <= 0) continue;

    const newSeqIn  = cursor;
    const newSeqOut = cursor + dur;

    for (const [trackName, clips] of Object.entries(src.tracks)) {
      for (const sclip of clips) {
        if (sclip.start <= origSeqIn && origSeqOut <= sclip.end) {
          const srcClipIn = parseInt(childByTag(sclip.elem, 'in').textContent);
          const offset = origSeqIn - sclip.start;
          if (!perTrack[trackName]) perTrack[trackName] = [];
          perTrack[trackName].push({
            seq_in: newSeqIn, seq_out: newSeqOut,
            src_in: srcClipIn + offset, src_out: srcClipIn + offset + dur,
            source_elem: sclip.elem,
            source_doc: src.doc,
            file_reg: src.fileReg,
            note: (pick.note || '') + ' [' + pick.source_file + ']',
          });
          break;
        }
      }
    }
    cursor = newSeqOut;
  }

  // Merge adjacent clips from same source
  for (const tn of Object.keys(perTrack)) {
    const merged = [];
    for (const c of perTrack[tn]) {
      const last = merged[merged.length - 1];
      if (last && last.source_elem === c.source_elem &&
          last.seq_out === c.seq_in && last.src_out === c.src_in) {
        last.seq_out = c.seq_out;
        last.src_out = c.src_out;
      } else merged.push({ ...c });
    }
    perTrack[tn] = merged;
  }

  const totalFrames = cursor;
  if (totalFrames === 0) throw new Error('No valid picks resolved against source tracks.');

  // Build output doc from template
  const newDoc = new DOMParser().parseFromString(templateXml, 'text/xml');
  const newSeq = newDoc.getElementsByTagName('sequence')[0];

  const nameNode = childByTag(newSeq, 'name');
  if (nameNode) nameNode.textContent = sequenceName;
  childByTag(newSeq, 'duration').textContent = String(totalFrames);
  const uuidNode = childByTag(newSeq, 'uuid');
  if (uuidNode) uuidNode.textContent = randomUUID();

  // Clear existing clips from all tracks
  const newMedia = childByTag(newSeq, 'media');
  for (const kind of ['video','audio']) {
    const sect = childByTag(newMedia, kind);
    if (!sect) continue;
    for (const tr of childrenByTag(sect, 'track')) {
      for (const ci of childrenByTag(tr, 'clipitem')) tr.removeChild(ci);
    }
  }

  function getTrack(name) {
    const kind = name[0] === 'V' ? 'video' : 'audio';
    const idx  = parseInt(name.slice(1)) - 1;
    return childrenByTag(childByTag(newMedia, kind), 'track')[idx];
  }

  const allEntries = [];
  for (const [tn, clips] of Object.entries(perTrack))
    for (const c of clips) allEntries.push([tn, c]);
  allEntries.sort((a,b) => a[1].seq_in - b[1].seq_in || a[0].localeCompare(b[0]));

  const fileIdsEmitted = new Set();
  let counter = 0;

  for (const [trackName, c] of allEntries) {
    const tr = getTrack(trackName);
    if (!tr) continue;
    // Import clip from its original source doc into the new doc
    const newCi = newDoc.importNode(c.source_elem, true);
    counter++;
    newCi.setAttribute('id', 'clipitem-' + counter);
    childByTag(newCi, 'start').textContent = String(c.seq_in);
    childByTag(newCi, 'end').textContent   = String(c.seq_out);
    childByTag(newCi, 'in').textContent    = String(c.src_in);
    childByTag(newCi, 'out').textContent   = String(c.src_out);
    const pptIn  = childByTag(newCi, 'pproTicksIn');
    const pptOut = childByTag(newCi, 'pproTicksOut');
    if (pptIn)  pptIn.textContent  = String(BigInt(c.src_in)  * pproTicks);
    if (pptOut) pptOut.textContent = String(BigInt(c.src_out) * pproTicks);

    const fileEl = childByTag(newCi, 'file');
    if (fileEl) {
      const fid = fileEl.getAttribute('id');
      if (fid) {
        if (fileIdsEmitted.has(fid)) {
          while (fileEl.firstChild) fileEl.removeChild(fileEl.firstChild);
        } else {
          if (fid in c.file_reg) {
            while (fileEl.firstChild) fileEl.removeChild(fileEl.firstChild);
            for (const child of c.file_reg[fid].childNodes)
              fileEl.appendChild(newDoc.importNode(child, true));
          }
          fileIdsEmitted.add(fid);
        }
      }
    }

    const loginfo = childByTag(newCi, 'logginginfo');
    if (loginfo && c.note) {
      let lognote = childByTag(loginfo, 'lognote');
      if (!lognote) { lognote = newDoc.createElement('lognote'); loginfo.appendChild(lognote); }
      lognote.textContent = c.note;
    }
    tr.appendChild(newCi);
  }

  let xmlOut = new XMLSerializer().serializeToString(newDoc);
  if (!xmlOut.startsWith('<?xml'))
    xmlOut = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + xmlOut;
  else if (!xmlOut.includes('<!DOCTYPE xmeml>'))
    xmlOut = xmlOut.replace(/(<\?xml[^?]*\?>)/, '$1\n<!DOCTYPE xmeml>');

  const secs = totalFrames / fps;
  const trackSummary = {};
  for (const [tn, clips] of Object.entries(perTrack)) {
    if (!clips.length) continue;
    const totF = clips.reduce((s,x) => s + (x.seq_out - x.seq_in), 0);
    trackSummary[tn] = { clipCount: clips.length, frames: totF, seconds: totF / fps };
  }

  return { xml: xmlOut, summary: { runtimeSeconds: secs, totalFrames, fps, tracks: trackSummary } };
}

// ── Local (Ollama) pick generation (multi-source) ────────────────────────────

function pickSeconds(transcript, p) {
  const seg = transcript.segments[p.seg];
  if (!seg || !seg.words) return 0;
  const w0 = seg.words[p.w_first];
  const wN = seg.words[p.w_last];
  if (!w0 || !wN) return 0;
  const dur = (wN.start + wN.duration) - w0.start;
  return dur > 0 ? dur : 0;
}

function trimPicks(picks, transcriptMap, targetSeconds) {
  const ceiling = targetSeconds * 1.15;
  let total = 0;
  const kept = [];
  for (const p of picks) {
    const transcript = transcriptMap[p.source_file];
    if (!transcript) continue;
    const dur = pickSeconds(transcript, p);
    if (dur <= 0) continue;
    if (total + dur > ceiling && kept.length > 0) break;
    kept.push(p);
    total += dur;
  }
  return { picks: kept, totalSeconds: total };
}

async function generatePicks(transcriptMap, brief, targetMinutes) {

  // Build combined transcript string with source attribution
  const transcriptSections = [];
  for (const [sourceFile, transcript] of Object.entries(transcriptMap)) {
        const speakerNames = {};
    for (const sp of (transcript.speakers || [])) speakerNames[sp.id] = sp.name;
    const segLines = transcript.segments.map((s, i) => {
      const text = s.words.map(w => w.text).filter(t => t).join(' ').trim();
      const minutes = (s.start / 60).toFixed(2);
      const nWords = s.words.length;
      const who = speakerNames[s.speaker];
      return `#${i} ${minutes}m [${nWords}w]${who ? ' ' + who + ':' : ''} ${text}`;
    });
    transcriptSections.push(`=== SOURCE: ${sourceFile} ===\n` + segLines.join('\n'));
  }

  let transcriptStr = transcriptSections.join('\n\n');
  if (transcriptStr.length > 120000) transcriptStr = transcriptStr.slice(0, 120000) + '\n[transcript truncated]';

  const targetSeconds = Math.round(targetMinutes * 60);
  const wordsPerSec = 2.2;
  const targetWords = Math.round(targetSeconds * wordsPerSec);
  const minWords = Math.round(targetWords * 0.9);
  const maxWords = Math.round(targetWords * 1.05);
  const minSeconds = Math.round(targetSeconds * 0.9);
  const maxSeconds = Math.round(targetSeconds * 1.05);
  const sourceFiles = Object.keys(transcriptMap);

  const systemPrompt = [
    'You are an expert documentary editor selecting soundbites from multiple interview transcripts.',
    '',
    'You will receive transcripts from multiple source files, each preceded by "=== SOURCE: filename ===".',
    'Each transcript line format: "#SEG_INDEX MINUTES [N_WORDS_IN_SEGMENT] full text"',
    '',
    'Select picks. Each pick must include the source_file it came from.',
    '',
    'RULES:',
    '- "seg" = the #N at start of line, scoped to its source file',
    '- "w_first" = first word index (0-based)',
    '- "w_last" = last word index (inclusive). MUST be < N from [Nw]',
    '- "source_file" MUST exactly match one of: ' + sourceFiles.map(f => '"' + f + '"').join(', '),
    '- Picks land in cutdown in ORDER YOU LIST THEM. Reorder freely for story.',
    '- English speech ~2.2 words/second.',
    '- TARGET RUNTIME IS A HARD CONSTRAINT. Total picked seconds MUST be within ±5% of target.',
    '- Each pick 5-30 seconds (roughly 10-65 words).',
    '- START and END at natural sentence boundaries.',
    '- SKIP slate calls, director cues, cross-talk.',
    '- "note" describes content concisely (max 10 words).',
    '',
    'Return ONLY valid JSON:',
    '{',
    '  "title": "Sequence Name - CUTDOWN",',
    '  "picks": [',
    '    {"source_file": "260601_Speedway Indiana_Ben Lipps_Interview_A-Cam", "seg": 12, "w_first": 5, "w_last": 28, "note": "opening point"},',
    '    {"source_file": "260601_Speedway Indiana_Curtis Leopardo_Interview_A-Cam", "seg": 3, "w_first": 0, "w_last": 18, "note": "counterpoint"}',
    '  ]',
    '}',
  ].join('\n');

  const userPrompt = [
    `TARGET RUNTIME: ${targetSeconds} seconds (${targetMinutes} minutes).`,
    `ACCEPTABLE RANGE: ${minSeconds}-${maxSeconds} seconds total.`,
    `TARGET WORD COUNT: ~${targetWords} words (range ${minWords}-${maxWords}).`,
    '',
    'CREATIVE BRIEF:',
    brief,
    '',
    'TRANSCRIPTS:',
    transcriptStr,
    '',
    'Return ONLY the picks JSON. Verify total word count fits range before responding.',
  ].join('\n');

  // Native Ollama /api/chat: lets us set num_ctx per-request, and
  // format:'json' constrains decoding to valid JSON.
  const result = await httpPostJson(OLLAMA_URL, '/api/chat', {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    format: 'json',
    stream: false,
    options: {
      num_ctx: OLLAMA_NUM_CTX,
      temperature: 0.3,
    },
  });
  if (result.error) throw new Error('Ollama error: ' + JSON.stringify(result.error).slice(0, 400));
  const text = result.message?.content?.trim();
  if (!text) throw new Error('Empty response from Ollama (' + JSON.stringify(result).slice(0, 200) + ')');

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let picksData;
  try { picksData = JSON.parse(cleaned); }
  catch(e) {
    // Forgiving fallback: extract the first balanced {...} block from a prose-wrapped reply
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { picksData = JSON.parse(cleaned.slice(first, last + 1)); } catch(e2) { picksData = null; }
    }
    if (!picksData) {
      console.error('LB generatePicks: unparseable model output:', cleaned.slice(0, 600));
      throw new Error('Could not parse picks JSON: ' + cleaned.slice(0, 400));
    }
  }
  if (!picksData.picks || !Array.isArray(picksData.picks)) {
    console.error('LB generatePicks: parsed but no picks array. Model output:', cleaned.slice(0, 600));
    throw new Error('Missing picks array');
  }
  if (picksData.picks.length === 0) {
    console.error('LB generatePicks: model returned zero picks. Model output:', cleaned.slice(0, 600));
    throw new Error('Model returned zero picks');
  }

  const trimmed = trimPicks(picksData.picks, transcriptMap, targetSeconds);
  picksData.picks = trimmed.picks;
  picksData._totalSeconds = trimmed.totalSeconds;
  picksData._targetSeconds = targetSeconds;
  return picksData;
}

// ── Route handlers ────────────────────────────────────────────────────────────

function serveLocalBridgePage(req, res) {
  fs.readFile(path.join(__dirname, 'local-bridge.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end('local-bridge.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

// POST /local-bridge/upload — multipart: project, xml file, json file
async function handleLBUpload(req, res) {
  try {
    // Parse multipart using formidable v2 style
    const form = new IncomingForm({ maxFileSize: 50 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
    });

    const project = Array.isArray(fields.project) ? fields.project[0] : fields.project;
    if (!project) { sendJSON(res, 400, { error: 'project name required' }); return; }

    const dir = projectDir(project);

    // Handle xml upload
    const xmlFile = Array.isArray(files.xml) ? files.xml[0] : files.xml;
    const jsonFile = Array.isArray(files.json) ? files.json[0] : files.json;

    if (!xmlFile || !jsonFile) { sendJSON(res, 400, { error: 'Both XML and JSON files required' }); return; }

    // Derive base name from XML filename
    const origName = (xmlFile.originalFilename || xmlFile.name || 'interview').replace(/\.xml$/i, '');
    const xmlDest  = path.join(dir, origName + '.xml');
    const jsonDest = path.join(dir, origName + '.json');

    fs.copyFileSync(xmlFile.filepath || xmlFile.path, xmlDest);
    fs.copyFileSync(jsonFile.filepath || jsonFile.path, jsonDest);

    sendJSON(res, 200, { ok: true, project, name: origName });
  } catch(err) {
    console.error('LB upload error:', err);
    sendJSON(res, 500, { error: err.message });
  }
}

// GET /local-bridge/library — list all projects and pairs
function handleLBLibrary(req, res) {
  sendJSON(res, 200, { library: listLibrary() });
}

// ── Query jobs ────────────────────────────────────────────────────────────────
// Long queries (local model inference can run minutes) must not hold an HTTP
// request open — Cloudflare kills anything past ~100s. Job pattern instead:
// POST /query returns { jobId } immediately; GET /query/status?id= polls.
const queryJobs = new Map();
const QUERY_JOB_TTL_MS = 60 * 60 * 1000; // keep results 1 hour

function pruneQueryJobs() {
  const now = Date.now();
  for (const [id, j] of queryJobs) {
    if (j.finishedAt && now - j.finishedAt > QUERY_JOB_TTL_MS) queryJobs.delete(id);
  }
}

// POST /local-bridge/query — start the cut, return a job id immediately
async function handleLBQuery(req, res) {
  try {
    const body = await parseBody(req);
    const { project, brief, targetMinutes, selectedFiles } = body;
    if (!project || !brief) { sendJSON(res, 400, { error: 'project and brief required' }); return; }

    const dir = path.join(LIBRARY_DIR, project.replace(/\s+/g, '_'));
    if (!fs.existsSync(dir)) { sendJSON(res, 404, { error: 'Project not found: ' + project }); return; }

    // Load all pairs in the project (or just selected ones)
    const files = fs.readdirSync(dir);
    const xmlFiles = files.filter(f => f.toLowerCase().endsWith('.xml'));
    if (!xmlFiles.length) { sendJSON(res, 400, { error: 'No XML files in project' }); return; }

    const sourceMap = {};
    const transcriptMap = {};

    for (const xmlFilename of xmlFiles) {
      const base = xmlFilename.replace(/\.xml$/i, '');
      if (selectedFiles && selectedFiles.length && !selectedFiles.includes(base)) continue;
      const jsonFilename = files.find(f =>
        f.replace(/\.json$/i,'').toLowerCase() === base.toLowerCase() && f.toLowerCase().endsWith('.json')
      );
      if (!jsonFilename) continue;

      const xmlText = fs.readFileSync(path.join(dir, xmlFilename), 'utf8');
      const jsonText = fs.readFileSync(path.join(dir, jsonFilename), 'utf8');
      let transcript;
      try { transcript = JSON.parse(jsonText); }
      catch(e) { console.warn('Bad JSON for', base, e.message); continue; }

      sourceMap[base]     = { xmlText, transcript };
      transcriptMap[base] = transcript;
    }

    if (!Object.keys(sourceMap).length) { sendJSON(res, 400, { error: 'No valid XML+JSON pairs found' }); return; }

    const target = parseFloat(targetMinutes) || 1;

    pruneQueryJobs();
    const jobId = randomUUID().slice(0, 8);
    const job = { id: jobId, status: 'running', startedAt: Date.now(), finishedAt: null, result: null, error: null };
    queryJobs.set(jobId, job);
    console.log('LB query started:', jobId, '(' + Object.keys(sourceMap).length + ' sources)');

    // Fire the long work in the background; the HTTP response returns now.
    (async () => {
      try {
        const picksData = await generatePicks(transcriptMap, brief, target);
        const seqName = picksData.title || 'Local Bridge Cutdown';

        const result = buildMultiSourceXml(picksData.picks, sourceMap, seqName);
        result.summary.title      = seqName;
        result.summary.pickCount  = picksData.picks.length;
        result.summary.targetSeconds = target * 60;
        result.summary.targetMinutes = target;
        result.summary.model      = OLLAMA_MODEL;
        result.summary.provider   = 'ollama-local';
        result.summary.sources    = Object.keys(sourceMap);

        job.result = result;
        job.status = 'done';
      } catch(err) {
        console.error('LB query job error:', jobId, err.message);
        job.error  = err.message;
        job.status = 'error';
      }
      job.finishedAt = Date.now();
    })();

    sendJSON(res, 200, { ok: true, jobId });
  } catch(err) {
    console.error('LB query error:', err);
    sendJSON(res, 500, { error: err.message });
  }
}

// GET /local-bridge/query/status?id=xxxx — poll for the result
function handleLBQueryStatus(req, res) {
  const q  = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id');
  const job = id && queryJobs.get(id);
  if (!job) { sendJSON(res, 404, { error: 'Unknown query job id' }); return; }

  const elapsedSec = Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);
  if (job.status === 'running') { sendJSON(res, 200, { status: 'running', elapsedSec }); return; }
  if (job.status === 'error')   { sendJSON(res, 200, { status: 'error', elapsedSec, error: job.error }); return; }
  sendJSON(res, 200, { status: 'done', elapsedSec, result: job.result });
}

module.exports = { serveLocalBridgePage, handleLBUpload, handleLBLibrary, handleLBQuery, handleLBQueryStatus, generatePicks, buildMultiSourceXml };
