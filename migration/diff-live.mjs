// Header-by-header, byte-by-byte diff of the Azure service against its Worker.
//
//   node migration/diff-live.mjs app
//   node migration/diff-live.mjs custody
//
// The contract suites pin the behaviour that matters; this catches everything
// they do not assert. Headers Cloudflare or Azure add for transport reasons
// (Date, CF-RAY, NEL, keep-alive…) are ignored — everything else must match.
const WHICH = process.argv[2] ?? 'app';

const TARGETS = {
  app: {
    azure: 'https://ht6-tomoyard.azurewebsites.net',
    worker: 'https://tomo-together-api.cloudflare-disjoin783.workers.dev',
    cases: [
      ['GET', '/health'], ['HEAD', '/health'], ['GET', '/Health'], ['GET', '/health?x=1'],
      ['DELETE', '/health'], ['GET', '/catalog'], ['GET', '/catalog/'], ['HEAD', '/catalog'],
      ['GET', '/'], ['GET', '/index.html'], ['GET', '/favicon.png'], ['GET', '/px'],
      ['GET', '/px/'], ['GET', '/px/avatar/cat_0.png'], ['GET', '/apk/version'],
      ['HEAD', '/apk'], ['GET', '/uploads'], ['GET', '/uploads/'],
      ['GET', '/uploads/nope-9f3a2b.jpg'], ['GET', '/uploads/a90ae881cb25a932ee4d.jpg'],
      ['GET', '/me'], ['PUT', '/me/avatar'], ['POST', '/auth/register'], ['POST', '/auth/login'],
      ['GET', '/nope'], ['POST', '/nope'], ['PUT', '/nope'], ['DELETE', '/nope'],
      ['OPTIONS', '/anything'], ['GET', '/auth/profile'], ['GET', '/wallet'],
      ['GET', '/hangouts/notanumber'], ['GET', '/friends/x'],
      ['GET', '/%41'], ['GET', '/a%2Fb'],
    ],
  },
  custody: {
    azure: 'https://ht6-tomoyard-crypto.azurewebsites.net',
    worker: 'https://tomo-together-custody.cloudflare-disjoin783.workers.dev',
    cases: [
      ['GET', '/health'], ['HEAD', '/health'], ['POST', '/health'], ['OPTIONS', '/health'],
      ['GET', '/readyz'], ['GET', '/catalog'], ['GET', '/treasury'], ['POST', '/withdraw'],
      ['POST', '/adjust'], ['POST', '/grant'], ['GET', '/nope'], ['DELETE', '/nope'],
      ['GET', '/users/ty_nobody'], ['POST', '/events'], ['POST', '/webhooks/unifold'],
    ],
  },
};

// Ignored: set by the edge/ingress, never by the application.
const IGNORE = new Set([
  'date', 'connection', 'keep-alive', 'transfer-encoding', 'server', 'cf-ray', 'nel',
  'report-to', 'alt-svc', 'cf-cache-status', 'vary', 'x-azure-ref', 'strict-transport-security',
  'content-encoding', 'set-cookie', 'request-context', 'x-powered-by-plesk',
]);

const target = TARGETS[WHICH];
if (!target) throw new Error(`unknown target ${WHICH}`);

async function probe(base, method, path) {
  const init = { method, redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } };
  if (method === 'POST' || method === 'PUT') {
    init.headers['Content-Type'] = 'application/json';
    init.body = '{}';
  }
  const res = await fetch(base + path, init);
  const bytes = Buffer.from(await res.arrayBuffer());
  const headers = {};
  for (const [k, v] of res.headers) {
    const key = k.toLowerCase();
    if (!IGNORE.has(key)) headers[key] = v;
  }
  return { status: res.status, headers, body: bytes };
}

let differences = 0;
for (const [method, path] of target.cases) {
  const [a, b] = await Promise.all([
    probe(target.azure, method, path),
    probe(target.worker, method, path),
  ]);
  const notes = [];
  if (a.status !== b.status) notes.push(`status ${a.status} -> ${b.status}`);
  const keys = [...new Set([...Object.keys(a.headers), ...Object.keys(b.headers)])].sort();
  for (const key of keys) {
    // ETag/Last-Modified on static files encode the file's mtime, which is the
    // R2 upload time here; the format matches, the value cannot.
    const isStaticValidator = key === 'etag' || key === 'last-modified';
    const bothStatic = a.headers['accept-ranges'] === 'bytes' && b.headers['accept-ranges'] === 'bytes';
    if (isStaticValidator && bothStatic && a.headers[key] && b.headers[key]) continue;
    if (a.headers[key] !== b.headers[key]) {
      notes.push(`${key}: ${JSON.stringify(a.headers[key])} -> ${JSON.stringify(b.headers[key])}`);
    }
  }
  if (!a.body.equals(b.body)) {
    notes.push(`body ${a.body.length}B -> ${b.body.length}B`);
  }
  if (notes.length) {
    differences += 1;
    console.log(`DIFF ${method} ${path}`);
    for (const n of notes) console.log(`       ${n}`);
  } else {
    console.log(`same ${method} ${path}`);
  }
}
console.log(differences === 0 ? '\nno differences' : `\n${differences} endpoint(s) differ`);
