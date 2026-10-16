'use strict';

function prepareTranscript(transcript, stem) {
  if (!Array.isArray(transcript?.segments)) throw new Error(`${stem}: missing transcript.segments`);
  const names = Object.fromEntries((transcript.speakers || []).map(s => [s.id, s.name || s.id]));
  const lines = transcript.segments.map((seg, i) => {
    const words = seg.words || [];
    const text = words.map(w => w.text || '').join(' ').replace(/\s+/g, ' ').trim();
    return `#${i} [${words.length} words] ${names[seg.speaker] || ''}: ${text}`;
  });
  return `=== SOURCE: ${stem} ===\n${lines.join('\n')}`;
}

function pickDuration(transcript, p) {
  const seg = transcript.segments[p.seg];
  if (!seg || !Array.isArray(seg.words)) throw new Error(`Invalid segment ${p.seg} in ${p.source_file}`);
  if (!Number.isInteger(p.w_first) || !Number.isInteger(p.w_last) || p.w_first < 0 || p.w_last < p.w_first || p.w_last >= seg.words.length) {
    throw new Error(`Invalid word range ${p.w_first}-${p.w_last} for segment ${p.seg} in ${p.source_file}`);
  }
  const first = seg.words[p.w_first], last = seg.words[p.w_last];
  if (![first.start, last.start, last.duration].every(Number.isFinite)) throw new Error(`Missing word-level timing in ${p.source_file} segment ${p.seg}`);
  return last.start + last.duration - first.start;
}

const schema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'picks'],
  properties: {
    title: {type:'string'},
    picks: {type:'array', items: {type:'object', additionalProperties:false,
      required:['source_file','seg','w_first','w_last','note'],
      properties: {source_file:{type:'string'},seg:{type:'integer'},w_first:{type:'integer'},w_last:{type:'integer'},note:{type:'string'}}}}
  }
};

async function generatePicks(map, brief, targetMinutes, model, key) {
  const material = Object.entries(map).map(([stem, t]) => prepareTranscript(t, stem)).join('\n\n');
  const target = Math.round(targetMinutes * 60);
  const prompt = `CREATIVE BRIEF:\n${brief}\n\nTARGET DURATION: approximately ${target} seconds. Prefer coherent storytelling over hitting a word-count exactly.\n\nTRANSCRIPTS:\n${material}`;
  const instructions = [
    'You are a highly skilled documentary interview editor. Select actual verbatim soundbites for a compelling narrative sequence.',
    'Return structured picks only. Pick source_file must exactly match a SOURCE identifier.',
    'Segment index is #N. Word indices w_first and w_last are inclusive and zero-based within that segment.',
    'Every selected word must exist in the transcript. Never invent dialogue or speaker attribution.',
    'Honor speaker restrictions from the creative brief. Omit interviewer speech when requested.',
    'Picks play back in the order returned; you may reorder source material to tell the best story.',
    'Favor logical narrative structure, complete thoughts, natural sentence boundaries, usable bites (often 5–30 seconds), and minimal repetition.',
    'Avoid slates, director cues, and off-topic cross-talk. Keep the total runtime close to target.',
    'The output XML will be built separately from your selections.'
  ].join('\n');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method:'POST', headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model, store:false, instructions, input:prompt,
      text:{format:{type:'json_schema',name:'narrative_picks',strict:true,schema}}})
  });
  const raw = await response.text();
  let body;
  try {body=JSON.parse(raw);}catch {throw new Error('OpenAI returned non-JSON response');}
  if (!response.ok) throw new Error(body.error?.message || `OpenAI HTTP ${response.status}`);
  const resultText = (body.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
  if (!resultText) throw new Error('OpenAI returned no output text' + (body.status ? ` (${body.status})` : ''));
  const result = JSON.parse(resultText);
  if (!Array.isArray(result.picks) || !result.picks.length) throw new Error('Model returned no picks');
  let totalSeconds = 0;
  for(const p of result.picks) {
    if (!Object.prototype.hasOwnProperty.call(map,p.source_file)) throw new Error(`Unknown source: ${p.source_file}`);
    const seconds=pickDuration(map[p.source_file],p);
    if (seconds<=0) throw new Error('A pick has zero/negative duration');
    totalSeconds += seconds;
  }
  return {...result, selectedSeconds:totalSeconds};
}
module.exports={generatePicks};
