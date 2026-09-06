// server.js — minimal host for Local Bridge on the GX10
const http = require('http');
const fs = require('fs');
const path = require('path');
const lb = require('./local-bridge');
const lbr = require('./lb-render');
const lbr2 = require('./lb-r2-routes');
const lbr2q = require('./lb-r2-query');
const lbr2r = require('./lb-r2-render');
const lbrb = require('./lb-broll');
const lbbc = require('./lb-broll-cut');

const PORT = parseInt(process.env.PORT || '8080', 10);

// Serve a static HTML file that lives next to this script.
function servePage(res, file) {
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  // CORS — allow the GitHub Pages app to call this box
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.split('?')[0];

  if (url === '/' || url === '/local-bridge') return lb.serveLocalBridgePage(req, res);
  if (url === '/local-bridge/upload'  && req.method === 'POST') return lb.handleLBUpload(req, res);
  if (url === '/local-bridge/library' && req.method === 'GET')  return lb.handleLBLibrary(req, res);
  if (url === '/local-bridge/r2-library' && req.method === 'GET') return lbr2.handleR2Library(req, res);
  if (url === '/awc-bridge' || url === '/awc') return lbr2.serveAWCBridgePage(req, res);
  if (url === '/vdo-bridge' || url === '/vdo') return servePage(res, 'vdo-bridge.html');
  if (url === '/passage-bridge' || url === '/passage') return servePage(res, 'passage-bridge.html');
  if (url === '/corniche-bridge' || url === '/corniche') return servePage(res, 'corniche-bridge.html');
  if (url === '/local-bridge/r2-query/status' && req.method === 'GET') return lbr2q.handleLBR2QueryStatus(req, res);
  if (url === '/local-bridge/r2-query' && req.method === 'POST') return lbr2q.handleLBR2Query(req, res);
  if (url === '/local-bridge/query/status' && req.method === 'GET') return lb.handleLBQueryStatus(req, res);
  if (url === '/local-bridge/query'   && req.method === 'POST') return lb.handleLBQuery(req, res);
  if (url.startsWith('/local-bridge/render/status'))   return lbr.handleLBRenderStatus(req, res);
  if (url.startsWith('/local-bridge/render/download')) return lbr.handleLBRenderDownload(req, res);
  if (url === '/local-bridge/render' && req.method === 'POST') return lbr.handleLBRenderStart(req, res);
  if (url.startsWith('/local-bridge/r2-render/status'))   return lbr2r.handleLBR2RenderStatus(req, res);
  if (url.startsWith('/local-bridge/r2-render/download')) return lbr2r.handleLBR2RenderDownload(req, res);
  if (url === '/local-bridge/r2-render' && req.method === 'POST') return lbr2r.handleLBR2RenderStart(req, res);
  if (url.startsWith('/local-bridge/r2-broll/reindex/status')) return lbrb.handleBrollReindexStatus(req, res);
  if (url === '/local-bridge/r2-broll/reindex' && req.method === 'POST') return lbrb.handleBrollReindex(req, res);
  if (url === '/local-bridge/r2-broll/thumb' && req.method === 'GET') return lbrb.handleBrollThumb(req, res);
  if (url === '/local-bridge/r2-reel' && req.method === 'GET') return lbrb.handleReelDownload(req, res);
  if (url === '/local-bridge/r2-broll' && req.method === 'GET') return lbrb.handleBrollSearch(req, res);
  if (url === '/local-bridge/r2-broll-cut' && req.method === 'POST') return lbbc.handleBrollCut(req, res);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Local Bridge running at http://localhost:' + PORT + '/local-bridge');
  console.log('Model: ' + (process.env.OLLAMA_MODEL || 'gpt-oss:120b') +
              ' via ' + (process.env.OLLAMA_URL || 'http://127.0.0.1:11434'));
});
