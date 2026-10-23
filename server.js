'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {generatePicks} = require('./lib/narrative');
const {buildMultiSourceXml} = require('./lib/xml-builder');
const {buildFullInterviewsXml} = require('./lib/full-interview');
const {sendXml} = require('./lib/email-editor');
const renderJobs = require('./lib/render-jobs');

const PORT=Number(process.env.PORT || 3030);
// Railway volume users can set PROJECTS_DIR to the volume's actual mount point.
const HOME=path.resolve(process.env.PROJECTS_DIR||path.join(__dirname,'projects'));
fs.mkdirSync(HOME,{recursive:true});
fs.mkdirSync(path.join(HOME,'Default'),{recursive:true});
const jobs=new Map();
function reply(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
async function bodyJSON(req){const chunks=[];let size=0;for await (const chunk of req){size+=chunk.length;if(size>40*1024*1024)throw Error('Upload too large (40 MB max)');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function safeName(s){const result=String(s||'').replace(/[^a-zA-Z0-9_. -]/g,'_').trim();if(!result||result==='.'||result==='..')throw Error('Invalid name');return result;}
function dirFor(project){return path.join(HOME,safeName(project));}
function projectNames(){return fs.readdirSync(HOME,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>e.name).sort((a,b)=>a==='Default'?-1:b==='Default'?1:a.localeCompare(b));}
function list(project){const dir=dirFor(project);if(!fs.existsSync(dir))return {pairs:[],orphans:[]};
 const files=fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()&&/\.(json|xml)$/.test(x.name)).map(x=>x.name);
 const sets=new Map();for(const file of files){const stem=file.slice(0,file.lastIndexOf('.')),ext=file.slice(file.lastIndexOf('.')+1);if(!sets.has(stem))sets.set(stem,new Set());sets.get(stem).add(ext);}
 const pairs=[],orphans=[];
 for(const [stem,extensions] of sets){if(extensions.has('xml')&&extensions.has('json'))pairs.push({stem});else for(const ext of extensions)orphans.push({stem,ext});}
 pairs.sort((a,b)=>a.stem.localeCompare(b.stem));orphans.sort((a,b)=>a.stem.localeCompare(b.stem));return {pairs,orphans};
}
function load(project,stems){const dir=dirFor(project),map={},transcripts={};for(const stem of stems){const name=safeName(stem);const xmlText=fs.readFileSync(path.join(dir,name+'.xml'),'utf8');const transcript=JSON.parse(fs.readFileSync(path.join(dir,name+'.json'),'utf8'));if(!Array.isArray(transcript.segments))throw Error(`${name} has no segments`);map[name]={xmlText,transcript};transcripts[name]=transcript;}return {map,transcripts};}
function serve(res){const file=path.join(__dirname,'public','index.html');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);}
function requireAdmin(){if(!process.env.BRIDGE_PASSWORD)throw Error('Set BRIDGE_PASSWORD in Railway Variables before enabling deletions');}
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/render'))return await renderJobs.route(req,res,url);
 if(!renderJobs.requireBrowser(req,res))return;
 if(req.method==='GET'&&url.pathname==='/')return serve(res);
 if(req.method==='GET'&&url.pathname==='/api/projects')return reply(res,200,{ok:true,projects:projectNames()});
 if(req.method==='POST'&&url.pathname==='/api/projects/create'){
   const b=await bodyJSON(req),name=safeName(b.name);
   if(name.length>100)throw Error('Project name is too long');
   const dir=dirFor(name);if(fs.existsSync(dir))return reply(res,409,{ok:false,error:'That project already exists'});
   fs.mkdirSync(dir);return reply(res,200,{ok:true,project:name});
 }
 if(req.method==='POST'&&url.pathname==='/api/projects/delete'){
   requireAdmin();const b=await bodyJSON(req),name=safeName(b.project),dir=dirFor(name);
   if(!fs.existsSync(dir))return reply(res,404,{ok:false,error:'Project does not exist'});
   if(name==='Default'){
     for(const entry of fs.readdirSync(dir))fs.rmSync(path.join(dir,entry),{recursive:true,force:true});
   }else fs.rmSync(dir,{recursive:true,force:true});
   return reply(res,200,{ok:true,project:name,deleted:true});
 }
 if(req.method==='GET'&&url.pathname==='/api/library')return reply(res,200,{ok:true,...list(url.searchParams.get('project')||'Default')});
 if(req.method==='POST'&&url.pathname==='/api/library/delete'){
   requireAdmin();const b=await bodyJSON(req),dir=dirFor(b.project||'Default'),stem=safeName(b.stem);
   const extensions=b.ext===undefined?['xml','json']:[b.ext];
   if(extensions.some(ext=>!['xml','json'].includes(ext)))throw Error('Invalid file type');
   let deleted=0;for(const ext of extensions){const file=path.join(dir,stem+'.'+ext);if(fs.existsSync(file)){fs.unlinkSync(file);deleted++;}}
   return reply(res,200,{ok:true,deleted,stem});
 }
 if(req.method==='POST'&&url.pathname==='/api/upload'){
   const b=await bodyJSON(req),project=safeName(b.project||'Default'),stem=safeName(b.stem);
   if(typeof b.xml!=='string'||typeof b.json!=='string')throw Error('Both XML and JSON required');
   const transcript=JSON.parse(b.json);
   if(!Array.isArray(transcript.segments))throw Error('Transcript JSON must contain segments[]');
   if(!b.xml.includes('<sequence'))throw Error('Source XML is missing a sequence');
   if(!fs.existsSync(dirFor(project)))throw Error('Select or create a project first');
   const dir=dirFor(project);
   fs.writeFileSync(path.join(dir,stem+'.xml'),b.xml);fs.writeFileSync(path.join(dir,stem+'.json'),b.json);
   return reply(res,200,{ok:true,stem,project});
 }
 if(req.method==='POST'&&url.pathname==='/api/generate'){
  const b=await bodyJSON(req),project=safeName(b.project||'Default');
  const stems=b.selectedFiles;if(!Array.isArray(stems)||!stems.length)throw Error('Select at least one interview');
  const brief=String(b.brief||'').trim(),wholeInterview=Boolean(b.wholeInterview)||brief.length===0;
  const target=Number(b.targetMinutes||1);
  if(!wholeInterview && (!Number.isFinite(target)||target<0.25||target>90))throw Error('Target must be between 0.25 and 90 minutes');
  const {map,transcripts}=load(project,stems);
  if(!wholeInterview && !process.env.OPENAI_API_KEY)throw Error('OPENAI_API_KEY is not set in Railway');
  const jobId=crypto.randomUUID();const job={status:'running',started:Date.now()};jobs.set(jobId,job);
  (async()=>{try{
   let assembled,picks=[],title;
   if(wholeInterview){assembled=buildFullInterviewsXml(stems,map);title=stems.length===1?`Complete Interview — ${stems[0]}`:'Complete Interviews';}
   else {const result=await generatePicks(transcripts,brief,target,process.env.OPENAI_MODEL||'gpt-4.1',process.env.OPENAI_API_KEY);picks=result.picks;title=result.title||'VDO Bridge Cut';assembled=buildMultiSourceXml(picks,map,title);}
   assembled.summary={...assembled.summary,title,pickCount:picks.length,sources:stems,model:wholeInterview?'no AI':(process.env.OPENAI_MODEL||'gpt-4.1'),targetMinutes:wholeInterview?null:target};
   const outdir=path.join(dirFor(project),'output');fs.mkdirSync(outdir,{recursive:true});
   const name='VDO_Bridge_'+new Date().toISOString().replace(/[:.]/g,'-')+'.xml';fs.writeFileSync(path.join(outdir,name),assembled.xml);
   job.status='done';job.result={...assembled,fileName:name,picks};
  }catch(e){job.status='error';job.error=e.message;console.error(e);}finally{job.finished=Date.now();}})();
  return reply(res,200,{ok:true,jobId});
 }
 if(req.method==='POST'&&url.pathname==='/api/email-xml'){
   const b=await bodyJSON(req);
   const sent=await sendXml({to:b.to||'brandon@thevdoaigency.com',project:b.project,fileName:b.fileName,xml:b.xml});
   return reply(res,200,{ok:true,...sent});
 }
 if(req.method==='GET'&&url.pathname==='/api/status'){
   const job=jobs.get(url.searchParams.get('id'));if(!job)return reply(res,404,{ok:false,error:'Job not found'});return reply(res,200,job);
 }
 reply(res,404,{ok:false,error:'Not found'});
 }catch(e){reply(res,400,{ok:false,error:e.message});}});
server.listen(PORT,'0.0.0.0',()=>console.log(`VDO Bridge listening on port ${PORT}`));
