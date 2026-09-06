// lb-r2-routes.js — HTTP route: list the R2 library for the Bridge UI dropdowns
// Reads from R2 via lb-r2.js. No credentials here — those live in the environment.
'use strict';

const r2 = require('./lb-r2');
const fs = require('fs');
const path = require('path');

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// GET /local-bridge/r2-library
// Returns every asset in the bucket, each flagged transcribed:true when it has
// both the .json and .xml sidecar. The narrative dropdown shows the transcribed ones.
async function handleR2Library(req, res) {
  try {
    const items = await r2.listLibrary();
    sendJSON(res, 200, {
      ok: true,
      bucket: r2.BUCKET,
      count: items.length,
      transcribedCount: items.filter(i => i.transcribed).length,
      library: items,
    });
  } catch (e) {
    console.error('R2 library route error:', e.message);
    sendJSON(res, 500, { ok: false, error: e.message });
  }
}

function serveAWCBridgePage(req, res) {
  fs.readFile(path.join(__dirname, 'awc-bridge.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end('awc-bridge.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

module.exports = { handleR2Library, serveAWCBridgePage };
