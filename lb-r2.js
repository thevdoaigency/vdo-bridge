// lb-r2.js — Cloudflare R2 connection for AWC Bridge (GX10)
// R2 is S3-compatible; we use the AWS S3 SDK pointed at the R2 endpoint.
// Holds the gx10-library-access token server-side — the browser never sees it.
//
// Env (required):
//   R2_ACCESS_KEY_ID       Access Key ID for gx10-library-access
//   R2_SECRET_ACCESS_KEY   Secret for that token
//   R2_ENDPOINT            https://<accountid>.r2.cloudflarestorage.com
//                          (or set R2_ACCOUNT_ID and we build the URL)
// Env (optional):
//   R2_BUCKET              defaults to 'vdo-library'
//
// CLI:  node lb-r2.js test   → verify the connection
//       node lb-r2.js list   → print the library

'use strict';

const {
  S3Client,
  ListObjectsV2Command,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');

const BUCKET   = process.env.R2_BUCKET || 'vdo-library';
const ENDPOINT = process.env.R2_ENDPOINT ||
  (process.env.R2_ACCOUNT_ID
    ? 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com'
    : null);
const ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

// Locked AWC company IDs → display names
const COMPANY = {
  LE:  'Leopardo Efficiency',
  LC:  'Leopardo Construction',
  GKE: 'Grand Kahn Electric',
  LH:  'Laystrom Hardware',
  EBT: 'Enlyt Building Technologies',
  DFH: 'DFH Connect',
  GP:  'GATOR',
  LCI: 'LCI Development Partners',
  AWC: 'Parent / family office',
};

// Lazy client — only throws if actually used without config, so `require()` is safe.
let _client = null;
function client() {
  if (_client) return _client;
  if (!ENDPOINT) throw new Error('R2 endpoint missing — set R2_ENDPOINT or R2_ACCOUNT_ID');
  if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY)
    throw new Error('R2 credentials missing — set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
  _client = new S3Client({
    region: 'auto', // R2 ignores region but the SDK requires one
    endpoint: ENDPOINT,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  });
  return _client;
}

// List every object key in the bucket (paginated).
async function listAllKeys(prefix) {
  const c = client();
  const keys = [];
  let token;
  do {
    const out = await c.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix || undefined,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const o of out.Contents || []) keys.push({ key: o.Key, size: o.Size });
    token = out.IsTruncated ? out.NextContinuationToken : null;
  } while (token);
  return keys;
}

// Turn a locked-convention stem into a readable label.
// YYMMDD_CompanyID_City_Name_Title
function friendlyName(stem) {
  const p = stem.split('_');
  if (p.length >= 5) {
    const name  = p[3];
    const title = p.slice(4).join(' ');
    const spaced = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    if (name.toLowerCase() === 'broll') return 'B-roll · ' + spaced(title);
    return spaced(name) + ' · ' + spaced(title);
  }
  return stem;
}

// Group objects by stem into library entries. A "transcribed" asset has both
// the .json and .xml sidecar — that's what the narrative dropdown should show.
async function listLibrary() {
  const keys = await listAllKeys();
  const byStem = {};
  for (const { key } of keys) {
    const slash  = key.lastIndexOf('/');
    const folder = slash >= 0 ? key.slice(0, slash) : '';
    const file   = slash >= 0 ? key.slice(slash + 1) : key;
    const dot    = file.lastIndexOf('.');
    if (dot < 0) continue;
    const stem = file.slice(0, dot);
    const ext  = file.slice(dot + 1).toLowerCase();
    if (!byStem[stem]) {
      byStem[stem] = {
        stem,
        company: stem.split('_')[1] || folder,
        label: friendlyName(stem),
        exts: {},
      };
    }
    byStem[stem].exts[ext] = key;
  }

  const items = Object.values(byStem).map(e => ({
    stem: e.stem,
    company: e.company,
    companyName: COMPANY[e.company] || e.company,
    label: e.label,
    hasMp4:  !!e.exts.mp4,
    hasJson: !!e.exts.json,
    hasXml:  !!e.exts.xml,
    transcribed: !!e.exts.json && !!e.exts.xml,
    keys: e.exts,
  }));
  items.sort((a, b) => a.stem.localeCompare(b.stem));
  return items;
}

// Prove the connection works, without pulling anything heavy.
async function testConnection() {
  await client().send(new HeadBucketCommand({ Bucket: BUCKET }));
  const items = await listLibrary();
  return {
    ok: true,
    bucket: BUCKET,
    endpoint: ENDPOINT,
    objectCount: items.length,
    transcribedPairs: items.filter(i => i.transcribed).length,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2] || 'test';
  (async () => {
    try {
      if (cmd === 'test') {
        console.log('R2 OK:\n' + JSON.stringify(await testConnection(), null, 2));
      } else if (cmd === 'list') {
        const items = await listLibrary();
        for (const i of items)
          console.log((i.transcribed ? '✓' : ' '), (i.company || '?').padEnd(4), i.stem);
        console.log('\n' + items.length + ' assets · ' +
          items.filter(i => i.transcribed).length + ' transcribed pairs');
      } else {
        console.log('Usage: node lb-r2.js [test|list]');
      }
    } catch (e) {
      console.error('R2 error:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { listLibrary, listAllKeys, testConnection, client, BUCKET, ENDPOINT };
