// Publishes a file or a directory tree into the R2 bucket the tomo-together-api
// Worker serves uploads/, apk/ and webapp/ from.
//
//   node scripts/r2-publish.mjs <local path> <r2 key or prefix>
//
//   node scripts/r2-publish.mjs tomo-yard.apk apk/tomo-yard.apk
//   node scripts/r2-publish.mjs dist        webapp
//
// Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_BUCKET
// (defaults to tomo-together-data).
//
// R2 is reached over its S3-compatible API, signed with the account API token
// (access key = token id, secret = sha256(token)). CI passes R2_PUBLISH_TOKEN,
// a token scoped to object read/write on this one bucket.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, posix } from 'node:path';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET || 'tomo-together-data';
const CONCURRENCY = Number(process.env.R2_CONCURRENCY || 8);

if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');
if (!ACCOUNT) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  throw new Error('usage: node scripts/r2-publish.mjs <local path> <r2 key or prefix>');
}

const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

let accessKeyId;
async function credentials() {
  if (!accessKeyId) {
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json();
    if (!body.success) throw new Error(`token verify failed: ${JSON.stringify(body.errors)}`);
    accessKeyId = body.result.id;
  }
  return { accessKeyId, secretAccessKey: sha256hex(TOKEN) };
}

async function put(key, body, contentType) {
  const { accessKeyId: ak, secretAccessKey: sk } = await credentials();
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const canonicalUri = `/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const headers = {
    host: HOST,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    names.map((h) => `${h}:${headers[h]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let signingKey = hmac(`AWS4${sk}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const res = await fetch(`https://${HOST}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`PUT ${key} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

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
function mimeFor(name) {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

function collect(path, keyPrefix) {
  const info = statSync(path);
  if (!info.isDirectory()) return [{ file: path, key: keyPrefix }];
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    out.push(...collect(join(path, entry.name), posix.join(keyPrefix, entry.name)));
  }
  return out;
}

const jobs = collect(source, statSync(source).isDirectory() ? target : target || basename(source));
console.log(`publishing ${jobs.length} object(s) to r2://${BUCKET}/`);

const queue = jobs.slice();
let done = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      await put(job.key, readFileSync(job.file), mimeFor(job.key));
      done += 1;
      if (done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length}`);
    }
  }),
);
console.log('done');
