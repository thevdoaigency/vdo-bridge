'use strict';
// Preserve COMPLETE original source timelines, including silence and production audio.
// Multiple interview sources are laid end-to-end with unique file/clip IDs.
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { randomUUID } = require('node:crypto');
function child(p, tag) {
  return p ? Array.from(p.childNodes).find(n => n.nodeType === 1 && n.tagName === tag) || null : null;
}
function children(p, tag) {
  return p ? Array.from(p.childNodes).filter(n => n.nodeType === 1 && n.tagName === tag) : [];
}
function text(p,tag) {const el=child(p,tag);return el?.textContent || '';}
function fpsOf(seq) {
  const rate=child(seq,'rate');const tb=Number(text(rate,'timebase'));
  if(!Number.isFinite(tb)||tb<=0)throw Error('Invalid sequence frame rate');
  return text(rate,'ntsc').trim().toUpperCase()==='TRUE'?tb*1000/1001:tb;
}
function sourceDoc(xml) {
  const doc=new DOMParser().parseFromString(xml.replace(/^\uFEFF/,''),'application/xml');
  const seq=doc.getElementsByTagName('sequence')[0];
  if(!seq)throw Error('Source XML has no sequence');
  const duration=Number(text(seq,'duration'));
  if(!Number.isInteger(duration)||duration<1)throw Error('Source XML sequence duration is invalid');
  return {doc,seq,duration,fps:fpsOf(seq)};
}
function fileRegistry(doc) {
  const defs=new Map();
  for(const f of Array.from(doc.getElementsByTagName('file'))) {
    const id=f.getAttribute('id');
    if(id && !defs.has(id) && Array.from(f.childNodes).some(n=>n.nodeType===1))defs.set(id,f);
  }
  return defs;
}
function trackCount(seq,kind) {return children(child(child(seq,'media'),kind),'track').length;}
function countClips(seq,kind) {return children(child(child(seq,'media'),kind),'track').reduce((n,tr)=>n+children(tr,'clipitem').length,0);}
function buildFullInterviewsXml(stems,sourceMap) {
  if(!Array.isArray(stems)||!stems.length)throw Error('Select at least one interview');
  const sources=stems.map(stem=>({stem,...sourceDoc(sourceMap[stem].xmlText)}));
  const fps=sources[0].fps;
  if(sources.some(s=>Math.abs(s.fps-fps)>0.0001))throw Error('Full interviews must use the same sequence frame rate. Export matching sequences first.');
  const frames=sources.reduce((t,s)=>t+s.duration,0);
  if(sources.length===1) {
    // Exact original XML: never reconstruct or shorten it from word timings.
    return {xml:sourceMap[stems[0]].xmlText,summary:{runtimeSeconds:frames/fps,totalFrames:frames,fps,tracks:{},mode:'Complete original interview'}};
  }
  const outDoc=new DOMParser().parseFromString(sourceMap[stems[0]].xmlText.replace(/^\uFEFF/,''),'text/xml');
  const seq=outDoc.getElementsByTagName('sequence')[0];
  child(seq,'name').textContent='Full Interviews — '+stems.join(', ');
  const uuid=child(seq,'uuid');if(uuid)uuid.textContent=randomUUID();
  child(seq,'duration').textContent=String(frames);
  const media=child(seq,'media');
  for(const kind of ['video','audio']) {
    const section=child(media,kind);
    const maximum=Math.max(...sources.map(s=>trackCount(s.seq,kind)));
    if(maximum && !section)throw Error('Source XML is missing '+kind+' section');
    // Copy empty track settings from source that has any additional tracks.
    while(children(section,'track').length<maximum) {
      const idx=children(section,'track').length;
      const source=sources.find(s=>trackCount(s.seq,kind)>idx);
      const tr=outDoc.importNode(children(child(child(source.seq,'media'),kind),'track')[idx],true);
      for(const ci of children(tr,'clipitem'))tr.removeChild(ci);
      section.appendChild(tr);
    }
    for(const tr of children(section,'track'))for(const ci of children(tr,'clipitem'))tr.removeChild(ci);
  }
  const seenFileIds=new Set();let offset=0;
  for(const [ix,source] of sources.entries()) {
    const registry=fileRegistry(source.doc);
    for(const kind of ['video','audio']) {
      const srcTracks=children(child(child(source.seq,'media'),kind),'track');
      const dstTracks=children(child(media,kind),'track');
      srcTracks.forEach((srcTrack,trackIx)=> {
        for(const ci of children(srcTrack,'clipitem')) {
          const clone=outDoc.importNode(ci,true);
          const clipId=ci.getAttribute('id');
          if(clipId)clone.setAttribute('id',`s${ix}_${clipId}`);
          const start=child(clone,'start'),end=child(clone,'end');
          if(start && Number.isFinite(Number(start.textContent)))start.textContent=String(Number(start.textContent)+offset);
          if(end && Number.isFinite(Number(end.textContent)))end.textContent=String(Number(end.textContent)+offset);
          for(const link of Array.from(clone.getElementsByTagName('linkclipref'))) {
            if(link.textContent)link.textContent=`s${ix}_${link.textContent}`;
          }
          // Source clip file references can repeat as empty <file id="..."/>.
          // Emit a complete source definition once for every unique prefixed ID.
          for(const f of Array.from(clone.getElementsByTagName('file'))) {
            const oldId=f.getAttribute('id');if(!oldId)continue;
            const newId=`s${ix}_${oldId}`;f.setAttribute('id',newId);
            while(f.firstChild)f.removeChild(f.firstChild);
            if(!seenFileIds.has(newId)) {
              const definition=registry.get(oldId);
              if(!definition)throw Error(`Missing file path definition for ${oldId} in ${source.stem}`);
              for(const node of Array.from(definition.childNodes))f.appendChild(outDoc.importNode(node,true));
              seenFileIds.add(newId);
            }
          }
          dstTracks[trackIx].appendChild(clone);
        }
      });
    }
    offset+=source.duration;
  }
  let xml=new XMLSerializer().serializeToString(outDoc);
  if(!xml.startsWith('<?xml'))xml='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n'+xml;
  else if(!xml.includes('<!DOCTYPE xmeml>'))xml=xml.replace(/(<\?xml[^?]*\?>)/,'$1\n<!DOCTYPE xmeml>');
  return {xml,summary:{runtimeSeconds:frames/fps,totalFrames:frames,fps,tracks:{},mode:`${stems.length} complete interviews`}};
}
module.exports={buildFullInterviewsXml};
