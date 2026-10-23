'use strict';
// Sends a generated XML as a real attachment. Requires RESEND_API_KEY,
// EMAIL_FROM (verified sending domain), and BRIDGE_PASSWORD on Railway.
function validEmail(value){return typeof value==='string' && value.length<=254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);}
async function sendXml({to,project,fileName,xml}) {
  if(!process.env.BRIDGE_PASSWORD)throw Error('Set BRIDGE_PASSWORD in Railway before enabling email');
  if(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM)throw Error('Email is not configured: add RESEND_API_KEY and EMAIL_FROM in Railway Variables');
  if(!validEmail(to))throw Error('Enter a valid editor email address');
  if(typeof xml!=='string'||xml.length<30||!xml.includes('<xmeml')||!xml.includes('<sequence'))throw Error('Generate an XML before sending');
  if(Buffer.byteLength(xml)>6*1024*1024)throw Error('XML exceeds email attachment size limit');
  const filename=String(fileName||'VDO_Bridge_Cut.xml').replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,120).replace(/\.+$/,'') || 'VDO_Bridge_Cut.xml';
  const body={
    from:process.env.EMAIL_FROM,
    to:[to],
    subject:`VDO Bridge XML — ${String(project||'Project').slice(0,100)}`,
    text:`VDO Bridge generated the attached Premiere XML for project "${String(project||'Project').slice(0,100)}".\n\nImport the attached XML in Adobe Premiere Pro. Source footage is not included.`,
    attachments:[{filename:filename.toLowerCase().endsWith('.xml')?filename:filename+'.xml',content:Buffer.from(xml).toString('base64')}]
  };
  let response;
  try {response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}
  catch(e){throw Error('Email provider unavailable: '+e.message);}
  const raw=await response.text();let result={};try{result=JSON.parse(raw)}catch{}
  if(!response.ok || !result.id)throw Error(result.message||result.error||`Email provider error ${response.status}`);
  return {id:result.id,to};
}
module.exports={sendXml};
