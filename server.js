'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {generatePicks} = require('./lib/narrative');
const {buildMultiSourceXml} = require('./lib/xml-builder');

const PORT=Number(process.env.PORT || 3030);
const HOME=path.join(__dirname,'projects');
fs.mkdirSync(HOME,{recursive:true});
const jobs=new Map();
function reply(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
async function bodyJSON(req){const chunks=[];let size=0;for await (const chunk of req){size+=chunk.length;if(size>40*1024*1024)throw Error('Upload too large (40 MB max)');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function safeName(s){const result=String(s||'').replace(/[^a-zA-Z0-9_. -]/g,'_').trim();if(!result || result==='.'||result==='..')throw Error('Invalid name');return result;}
function dirFor(project){return path.join(HOME,safeName(project));}
function list(project){const dir=dirFor(project);if(!fs.existsSync(dir))return [];
 const files=fs.readdirSync(dir);return files.filter(f=>f.endsWith('.json')&&files.includes(f.slice(0,-5)+'.xml')).map(f=>({stem:f.slice(0,-5)}));}
function load(project,stems){const dir=dirFor(project),map={},transcripts={};for(const stem of stems){const name=safeName(stem);const xmlText=fs.readFileSync(path.join(dir,name+'.xml'),'utf8');const transcript=JSON.parse(fs.readFileSync(path.join(dir,name+'.json'),'utf8'));if(!Array.isArray(transcript.segments))throw Error(`${name} has no segments`);map[name]={xmlText,transcript};transcripts[name]=transcript;}return {map,transcripts};}
function serve(res){const file=path.join(__dirname,'public','index.html');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);}
const server=http.createServer(async (req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/')return serve(res);
 if(req.method==='GET'&&url.pathname==='/api/projects'){return reply(res,200,{ok:true,projects:fs.readdirSync(HOME,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name)});}
 if(req.method==='GET'&&url.pathname==='/api/library')return reply(res,200,{ok:true,pairs:list(url.searchParams.get('project')||'Default')});
 if(req.method==='POST'&&url.pathname==='/api/upload'){
   const b=await bodyJSON(req),project=safeName(b.project||'Default'),stem=safeName(b.stem);
   if(typeof b.xml!=='string'||typeof b.json!=='string')throw Error('Both XML and JSON required');
   const transcript=JSON.parse(b.json);
   if(!Array.isArray(transcript.segments))throw Error('Transcript JSON must contain segments[]');
   if(!b.xml.includes('<sequence'))throw Error('Source XML is missing a sequence');
   const dir=dirFor(project);fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,stem+'.xml'),b.xml);fs.writeFileSync(path.join(dir,stem+'.json'),b.json);
   return reply(res,200,{ok:true,stem,project});
 }
 if(req.method==='POST'&&url.pathname==='/api/generate'){
  const b=await bodyJSON(req);const project=safeName(b.project||'Default');
  const stems=b.selectedFiles;if(!Array.isArray(stems)||!stems.length)throw Error('Select at least one interview');
  const target=Number(b.targetMinutes||1);if(!Number.isFinite(target)||target<0.25||target>90)throw Error('Target must be between 0.25 and 90 minutes');
  const {map,transcripts}=load(project,stems);
  if(!b.wholeInterview && !String(b.brief||'').trim())throw Error('Enter a story brief');
  if(!b.wholeInterview && !process.env.OPENAI_API_KEY)throw Error('OPENAI_API_KEY is not set. Add it to your Mac environment.');
  const jobId=crypto.randomUUID();const job={status:'running',started:Date.now()};jobs.set(jobId,job);
  (async()=>{try{
   let result;
   if(b.wholeInterview){const picks=[];for(const stem of stems){transcripts[stem].segments.forEach((s,i)=>{if(s.words?.length)picks.push({source_file:stem,seg:i,w_first:0,w_last:s.words.length-1,note:'whole interview'});});}result={title:'Full interview assembly',picks};}
   else result=await generatePicks(transcripts,b.brief,target,process.env.OPENAI_MODEL||'gpt-4.1',process.env.OPENAI_API_KEY);
   const assembled=buildMultiSourceXml(result.picks,map,result.title||'VDO Bridge Cut');
   assembled.summary={...assembled.summary,title:result.title,pickCount:result.picks.length,sources:stems,model:b.wholeInterview?'no AI':(process.env.OPENAI_MODEL||'gpt-4.1'),targetMinutes:target};
   const outdir=path.join(dirFor(project),'output');fs.mkdirSync(outdir,{recursive:true});
   const name='VDO_Bridge_'+new Date().toISOString().replace(/[:.]/g,'-')+'.xml';fs.writeFileSync(path.join(outdir,name),assembled.xml);
   job.status='done';job.result={...assembled,fileName:name,picks:result.picks};
  }catch(e){job.status='error';job.error=e.message;console.error(e);}finally{job.finished=Date.now();}})();
  return reply(res,200,{ok:true,jobId});
 }
 if(req.method==='GET'&&url.pathname==='/api/status'){const job=jobs.get(url.searchParams.get('id'));if(!job)return reply(res,404,{ok:false,error:'Job not found'});return reply(res,200,job);}
 reply(res,404,{ok:false,error:'Not found'});
 }catch(e){reply(res,400,{ok:false,error:e.message});}});
server.listen(PORT,'0.0.0.0',()=>console.log(`VDO Bridge listening on port ${PORT}`));
