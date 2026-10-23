'use strict';
// Send real XML attachments from a Gmail account (e.g. thevdoaigency@gmail.com).
// Railway variables: BRIDGE_PASSWORD, GMAIL_USER, GMAIL_APP_PASSWORD.
// Requires a Google App Password (with Gmail 2-Step Verification enabled),
// not the user's regular Gmail password.
const nodemailer = require('nodemailer');

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

async function sendXml({to, project, fileName, xml}) {
  // Ensure users cannot send email unless browser authentication is enabled.
  // server.js protects the endpoint with HTTP Basic auth when BRIDGE_PASSWORD is set.
  if (!process.env.BRIDGE_PASSWORD) throw Error('Set BRIDGE_PASSWORD in Railway before enabling email');
  const user = (process.env.GMAIL_USER || '').trim();
  const password = process.env.GMAIL_APP_PASSWORD || '';
  if (!user || !password) throw Error('Gmail is not configured: add GMAIL_USER and GMAIL_APP_PASSWORD in Railway Variables');
  if (!validEmail(user)) throw Error('GMAIL_USER is not a valid email address');
  if (!validEmail(to)) throw Error('Enter a valid editor email address');
  if (typeof xml !== 'string' || xml.length < 30 || !xml.includes('<xmeml') || !xml.includes('<sequence')) {
    throw Error('Generate an XML before sending');
  }
  if (Buffer.byteLength(xml) > 6 * 1024 * 1024) throw Error('XML exceeds email attachment size limit');

  const filename = String(fileName || 'VDO_Bridge_Cut.xml')
    .replace(/[^a-zA-Z0-9_. -]/g, '_').slice(0, 120).replace(/\.+$/, '') || 'VDO_Bridge_Cut.xml';
  const attachmentName = filename.toLowerCase().endsWith('.xml') ? filename : filename + '.xml';
  const name = String(project || 'Project').replace(/[\r\n]/g, ' ').slice(0, 100);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: password },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000
  });

  let info;
  try {
    info = await transporter.sendMail({
      from: { name: 'VDO Bridge', address: user },
      to,
      subject: `VDO Bridge XML — ${name}`,
      text: `The attached Premiere XML was generated for project "${name}".\n\nImport the attached XML in Adobe Premiere Pro. Original source footage is not included.`,
      attachments: [{filename: attachmentName, content: Buffer.from(xml, 'utf8'), contentType: 'application/xml'}]
    });
  } catch (e) {
    throw Error('Gmail could not send the XML: ' + e.message);
  }
  if (!info.accepted?.some(address => address.toLowerCase() === to.toLowerCase())) {
    throw Error('Gmail did not accept the recipient');
  }
  return {id: info.messageId || null, to};
}
module.exports = {sendXml};
