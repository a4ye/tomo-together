// Shared black-box HTTP helpers. Nothing here imports application code: every
// assertion in these suites is made against a real HTTP response from BASE_URL.
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

export function baseUrl() {
  const raw = (process.env.BASE_URL || '').trim();
  if (!raw) {
    throw new Error('BASE_URL is required, e.g. BASE_URL=https://ht6-tomoyard.azurewebsites.net');
  }
  return raw.replace(/\/+$/, '');
}

const TIMEOUT_MS = Number(process.env.CONTRACT_TIMEOUT_MS || 30_000);

/**
 * One HTTP request. Returns status, a lower-cased header map, the raw body text
 * and its sha256 so byte-level assertions are possible.
 */
export async function req(method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = init.headers['Content-Type'] ?? 'application/json';
  }
  const response = await fetch(baseUrl() + path, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const buf = Buffer.from(await response.arrayBuffer());
  const h = {};
  for (const [k, v] of response.headers) h[k.toLowerCase()] = v;
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
  return {
    status: response.status,
    headers: h,
    text: buf.toString('utf8'),
    bytes: buf,
    sha256: createHash('sha256').update(buf).digest('hex'),
    json,
  };
}

/** The three CORS headers the app sets on every single response. */
export const APP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,Authorization,Idempotency-Key',
};

/**
 * Raw HTTP/1.1 Upgrade handshake, so the exact status line of a rejected
 * WebSocket upgrade is observable (the WebSocket client API hides it).
 * Returns the response head as a string.
 */
export function upgradeHandshake(pathAndQuery) {
  const url = new URL(baseUrl());
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const secure = url.protocol === 'https:';
  return new Promise((resolve) => {
    const opts = { host: url.hostname, port, servername: url.hostname };
    const socket = secure ? tls.connect(opts, onReady) : net.connect(opts, onReady);
    let buf = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(buf.split('\r\n\r\n')[0]);
    };
    function onReady() {
      socket.write(
        `GET ${pathAndQuery} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    }
    const timer = setTimeout(done, TIMEOUT_MS);
    socket.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) done(); });
    socket.on('close', done);
    socket.on('error', (e) => { buf = buf || 'SOCKET_ERROR ' + e.message; done(); });
  });
}
