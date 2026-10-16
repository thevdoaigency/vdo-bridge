'use strict';
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { randomUUID } = require('crypto');
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


module.exports = { buildMultiSourceXml };
