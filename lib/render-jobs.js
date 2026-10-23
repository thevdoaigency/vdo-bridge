'use strict';
// Railway-side bridge: authenticated browser queues XML; Mac Mini polls over HTTPS;
// MP4 is temporarily relayed back for the producer's download. No media originals uploaded.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const jobStore = new Map();
const outDir = path.join(os.tmpdir(), 'vdo-bridge-mp4');
fs.mkdirSync(outDir, { recursive: true });
const ttl = 2 * 60 * 60 * 1000;
const maxUploadBytes = 300 * 1024 * 1024;
let workerLastSeen = 0;
function json(res,status,obj) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function eq(a,b){if(!a||!b)return false;const x=Buffer.from(a), y=Buffer.from(b);return x.length===y.length && crypto.timingSafeEqual(x,y);}
function workerAuth(req){return eq(req.headers['x-vdo-worker-token'],process.env.RENDER_WORKER_TOKEN);}
function clientPasswordReady(){return Boolean(process.env.BRIDGE_PASSWORD && process.env.RENDER_WORKER_TOKEN);}
function browserAuth(req){
  const password=process.env.BRIDGE_PASSWORD;
  if(!password) return true; // Homepage/narrative remain as previously deployed until enabled.
  const header=String(req.headers.authorization||'');
  if(!header.startsWith('Basic '))return false;
  try {const decoded=Buffer.from(header.slice(6),'base64').toString('utf8');return eq(decoded.slice(decoded.indexOf(':')+1),password);}catch{return false;}
}
function requireBrowser(req,res){
  if(browserAuth(req))return true;
  res.writeHead(401,{'WWW-Authenticate':'Basic realm="VDO Bridge"','Content-Type':'text/plain','Cache-Control':'no-store'});
  res.end('VDO Bridge requires a password.');return false;
}
async function body(req,limit=5*1024*1024){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>limit)throw Error('Payload too large');chunks.push(part);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function prune(){
 const now=Date.now();
 for(const [id,j] of jobStore) if(now-j.created>ttl){if(j.output)try{fs.unlinkSync(j.output);}catch{}jobStore.delete(id);}
}
function responseStatus(j){return {ok:true,status:j.status,error:j.error||null,fileName:j.filename||null,workerOnline:Date.now()-workerLastSeen<20000};}
function niceFileName(s){return String(s||'VDO_Bridge_Rough_Cut').replace(/[^a-zA-Z0-9_-]+/g,'_').slice(0,100).replace(/^_+|_+$/g,'')+'.mp4';}
async function route(req,res,url){
 prune();
 const p=url.pathname;
 // Worker endpoints all use their own token and are never accessible from browser auth.
 if(p.startsWith('/api/render/worker/')){
   if(!process.env.RENDER_WORKER_TOKEN || !workerAuth(req))return json(res,401,{ok:false,error:'Invalid worker token'});
   workerLastSeen=Date.now();
   if(p==='/api/render/worker/next' && req.method==='GET'){
     let j=Array.from(jobStore.values()).find(x=>x.status==='queued');
     if(j){j.status='rendering';j.started=Date.now();j.attempts++;}
     return json(res,200,j?{ok:true,job:{id:j.id,xml:j.xml,preset:j.preset,filename:j.filename}}:{ok:true,job:null});
   }
   if(p==='/api/render/worker/error' && req.method==='POST'){
     const b=await body(req);const j=jobStore.get(b.id);
     if(!j)return json(res,404,{ok:false,error:'Unknown job'});
     j.status='error';j.error=String(b.error||'Mac renderer failed').slice(0,2000);delete j.xml;
     return json(res,200,{ok:true});
   }
   if(p==='/api/render/worker/upload' && req.method==='POST'){
     const id=url.searchParams.get('id'),j=jobStore.get(id);
     if(!j|| !['rendering','uploading'].includes(j.status))return json(res,404,{ok:false,error:'Unknown render job'});
     const size=Number(req.headers['content-length']||0);
     if(size>maxUploadBytes)return json(res,413,{ok:false,error:'MP4 exceeds 300MB limit'});
     j.status='uploading';
     const target=path.join(outDir,j.id+'.mp4');
     let total=0;
     try{
       await new Promise((resolve,reject)=>{
         const out=fs.createWriteStream(target,{flags:'wx'});
         req.on('data',c=>{total+=c.length;if(total>maxUploadBytes)req.destroy(new Error('MP4 exceeds 300MB'));});
         req.on('error',reject);out.on('error',reject);out.on('finish',resolve);
         req.pipe(out);
       });
     }catch(err){try{fs.unlinkSync(target)}catch{}j.status='error';j.error='Upload failed: '+err.message;return json(res,500,{ok:false,error:j.error});}
     j.status='ready';j.output=target;j.sizeBytes=total;delete j.xml;
     return json(res,200,{ok:true,sizeBytes:total});
   }
   return json(res,404,{ok:false,error:'Unknown worker endpoint'});
 }
 if(!requireBrowser(req,res))return;
 if(p==='/api/render' && req.method==='POST'){
   if(!clientPasswordReady())return json(res,503,{ok:false,error:'Railway needs BRIDGE_PASSWORD and RENDER_WORKER_TOKEN configured'});
   const b=await body(req,12*1024*1024);
   if(typeof b.xml!=='string' || !b.xml.includes('<xmeml') || !b.xml.includes('<sequence'))
     return json(res,400,{ok:false,error:'Submit Premiere FCP7 XML'});
   const id=crypto.randomUUID();
   const j={id,created:Date.now(),status:'queued',xml:b.xml,
     filename:niceFileName(b.name||'VDO_Bridge_Cut'),preset:b.preset==='full'?'full':'draft',attempts:0};
   jobStore.set(id,j);return json(res,200,{ok:true,id});
 }
 if(p==='/api/render/status' && req.method==='GET'){
   const j=jobStore.get(url.searchParams.get('id'));
   return j?json(res,200,responseStatus(j)):json(res,404,{ok:false,error:'Job expired or not found'});
 }
 if(p==='/api/render/download' && req.method==='GET'){
   const j=jobStore.get(url.searchParams.get('id'));
   if(!j||j.status!=='ready'||!j.output||!fs.existsSync(j.output))return json(res,404,{ok:false,error:'MP4 not available'});
   res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':fs.statSync(j.output).size,
     'Content-Disposition':`attachment; filename="${j.filename}"`,'Cache-Control':'private, no-store'});
   fs.createReadStream(j.output).pipe(res);return;
 }
 return json(res,404,{ok:false,error:'Unknown render endpoint'});
}
module.exports={route,requireBrowser};
