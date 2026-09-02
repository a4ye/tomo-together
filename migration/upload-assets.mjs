// Copies everything the Express server served off disk into the R2 bucket that
// replaces DATA_DIR.
//
//   CLOUDFLARE_API_TOKEN=… KUDU_CREDS=path/to.json node migration/upload-assets.mjs [prefix…]
//
//   server/public/**            -> public/**    (marketing site, from the repo)
//   /home/data/uploads/*        -> uploads/*    (hangout photos, from Kudu VFS)
//   /home/data/apk/*            -> apk/*        (APK + version.json, from Kudu VFS)
//   /home/data/webapp/**        -> webapp/**    (Expo web bundle, from Kudu VFS)
//
// R2 is reached over its S3-compatible API with SigV4: the account's API token
// doubles as S3 credentials (access key = token id, secret = sha256(token)).
// Nothing is written to Azure — every Kudu call here is a GET.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT = 'b0e98c15b1f905a394ecd6a849e8e99f';
const BUCKET = 'tomo-together-data';
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KUDU_CREDS = process.env.KUDU_CREDS;
if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'server', 'public');
const only = process.argv.slice(2);
const wanted = (prefix) => only.length === 0 || only.some((p) => prefix.startsWith(p) || p.startsWith(prefix));

// ------------------------------------------------------------------ SigV4 --

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

let accessKeyId;
async function credentials() {
  if (accessKeyId) return { accessKeyId, secretAccessKey: sha256hex(TOKEN) };
  const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`token verify failed: ${JSON.stringify(body.errors)}`);
  accessKeyId = body.result.id;
  return { accessKeyId, secretAccessKey: sha256hex(TOKEN) };
}

async function signedPut(key, body, contentType) {
  const { accessKeyId: ak, secretAccessKey: sk } = await credentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const canonicalUri =
    '/' + BUCKET + '/' + key.split('/').map((s) => encodeURIComponent(s)).join('/');
  const headers = {
    host: HOST,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h]}\n`)
    .join('');
  const canonicalRequest = [
    'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');
  let signingKey = hmac(`AWS4${sk}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${HOST}${canonicalUri}`, {
    method: 'PUT',
    headers: { ...headers, Authorization: authorization },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${key} -> ${res.status} ${await res.text()}`);
}

// ----------------------------------------------------------------- sources --

const MIME = {
  '.html': 'text/html; charset=UTF-8', '.css': 'text/css; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8', '.mjs': 'text/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8', '.map': 'application/json; charset=UTF-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=UTF-8', '.apk': 'application/vnd.android.package-archive',
  '.webmanifest': 'application/manifest+json',
};
const mimeFor = (name) => {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
};

function localFiles(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...localFiles(full, posix.join(prefix, entry.name)));
    else out.push({ key: posix.join(prefix, entry.name), read: () => readFileSync(full), size: statSync(full).size });
  }
  return out;
}

function kuduAuth() {
  if (!KUDU_CREDS) throw new Error('KUDU_CREDS is required for the /home/data sources');
  const c = JSON.parse(readFileSync(KUDU_CREDS, 'utf8'));
  return 'Basic ' + Buffer.from(`${c.u}:${c.p}`).toString('base64');
}

async function kuduFiles(vfsPath, prefix) {
  const auth = kuduAuth();
  const out = [];
  const walk = async (p, keyPrefix) => {
    const res = await fetch(`https://ht6-tomoyard.scm.azurewebsites.net/api/vfs/${p}`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) throw new Error(`kudu list ${p} -> ${res.status}`);
    for (const entry of await res.json()) {
      const child = `${p}${encodeURIComponent(entry.name)}`;
      if (entry.mime === 'inode/directory') await walk(`${child}/`, posix.join(keyPrefix, entry.name));
      else {
        out.push({
          key: posix.join(keyPrefix, entry.name),
          size: entry.size,
          read: async () => {
            const r = await fetch(`https://ht6-tomoyard.scm.azurewebsites.net/api/vfs/${child}`, {
              headers: { Authorization: auth },
            });
            if (!r.ok) throw new Error(`kudu get ${child} -> ${r.status}`);
            return Buffer.from(await r.arrayBuffer());
          },
        });
      }
    }
  };
  await walk(vfsPath, prefix);
  return out;
}

// -------------------------------------------------------------------- run --

const jobs = [];
if (wanted('public/')) jobs.push(...localFiles(PUBLIC_DIR, 'public'));
if (wanted('uploads/')) jobs.push(...(await kuduFiles('data/uploads/', 'uploads')));
if (wanted('apk/')) jobs.push(...(await kuduFiles('data/apk/', 'apk')));
if (wanted('webapp/')) jobs.push(...(await kuduFiles('data/webapp/', 'webapp')));

console.log(`${jobs.length} objects, ${(jobs.reduce((a, j) => a + j.size, 0) / 1e6).toFixed(1)} MB`);

let done = 0;
let bytes = 0;
const queue = jobs.slice();
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const body = await job.read();
    await signedPut(job.key, body, mimeFor(job.key));
    done += 1;
    bytes += body.length;
    if (done % 25 === 0 || done === jobs.length) {
      console.log(`  ${done}/${jobs.length} (${(bytes / 1e6).toFixed(1)} MB)`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log('done');
