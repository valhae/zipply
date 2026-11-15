// P8-07: checks a deployment against a local build of the same commit and env (docs/RELEASE.md):
// every built file byte-for-byte, the security headers, HTTP→HTTPS, TLS versions, and the
// signaling Origin/HTTPS checks. Writes SHA256SUMS for the release notes.
// Usage: node scripts/release/verify-deploy.mjs <site-url> <signaling-url> <dist> [out-file]
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { join } from 'node:path';
import { connect } from 'node:tls';

const [siteArg, signalingArg, dist, out = 'SHA256SUMS'] = process.argv.slice(2);
if (!siteArg || !signalingArg || !dist) {
  throw new Error('usage: verify-deploy.mjs <site-url> <signaling-url> <dist> [out-file]');
}
const site = new URL(siteArg);
const signaling = new URL(signalingArg.replace(/^ws/, 'http'));
if (site.protocol !== 'https:' || signaling.protocol !== 'https:') throw new Error('https only');

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}\n`);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// 1. Deployed files equal the local build.
const files = readdirSync(dist, { recursive: true })
  .map((f) => String(f).replaceAll('\\', '/'))
  .filter((f) => statSync(join(dist, f)).isFile())
  .sort();
const sums = [];
for (const f of files) {
  const local = sha256(readFileSync(join(dist, f)));
  const res = await fetch(new URL(f === 'index.html' ? '/' : `/${f}`, site), { redirect: 'error' });
  const remote = sha256(Buffer.from(await res.arrayBuffer()));
  check(res.ok && remote === local, `file ${f}`, res.ok ? '' : `HTTP ${res.status}`);
  sums.push(`${local}  ${f}`);
}
writeFileSync(out, `${sums.join('\n')}\n`);

// 2. Security headers equal apps/web/vercel.json.
const expected = JSON.parse(readFileSync(new URL('../../apps/web/vercel.json', import.meta.url)))
  .headers[0].headers;
const page = await fetch(site, { redirect: 'error' });
for (const { key, value } of expected) {
  check(page.headers.get(key) === value, `header ${key}`);
}

// 3. Plain HTTP redirects to HTTPS.
const plain = await new Promise((resolve, reject) =>
  httpRequest(`http://${site.host}/`, (r) => resolve(r))
    .on('error', reject)
    .end(),
);
check(
  [301, 302, 307, 308].includes(plain.statusCode) && plain.headers.location?.startsWith('https://'),
  'HTTP redirects to HTTPS',
  String(plain.statusCode),
);
plain.resume();

// 4. TLS: 1.3 negotiated; 1.2 accepted (documented minimum); 1.1 refused.
const tls = (host, version) =>
  new Promise((resolve) => {
    const s = connect({
      host,
      servername: host,
      port: 443,
      minVersion: version,
      maxVersion: version,
    });
    s.once('secureConnect', () => (resolve(s.getProtocol()), s.end()));
    s.once('error', () => resolve(null));
  });
for (const host of [site.hostname, signaling.hostname]) {
  check((await tls(host, 'TLSv1.3')) === 'TLSv1.3', `${host} negotiates TLS 1.3`);
  check((await tls(host, 'TLSv1.2')) === 'TLSv1.2', `${host} accepts TLS 1.2`);
  // A refusal may come from the server or from this machine's OpenSSL; either way no TLS 1.1.
  check((await tls(host, 'TLSv1.1')) === null, `${host} has no TLS 1.1 session`);
}

// 5. Signaling: health, Origin allowlist and HTTPS-only upgrades.
const health = await fetch(new URL('/healthz', signaling));
check(health.ok, 'signaling /healthz', String(health.status));
const upgrade = (secure, origin) =>
  new Promise((resolve) => {
    const url = `${secure ? 'https' : 'http'}://${signaling.host}/ws`;
    const req = (secure ? request : httpRequest)(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('upgrade', (_res, socket) => (resolve(101), socket.destroy()));
    req.on('response', (res) => (resolve(res.statusCode), res.resume()));
    req.on('error', () => resolve(null));
    req.end();
  });
check((await upgrade(true, site.origin)) === 101, 'WSS upgrade from the site origin → 101');
const lookalike = `https://${site.hostname}.evil.example`;
check((await upgrade(true, lookalike)) === 403, 'WSS upgrade from another origin → 403');
check((await upgrade(true, null)) === 403, 'WSS upgrade without Origin → 403');
check((await upgrade(false, site.origin)) !== 101, 'plain ws:// upgrade refused');

process.stdout.write(
  `\n${failed ? `${failed} check(s) FAILED` : 'All checks passed'}; wrote ${out}\n`,
);
process.exitCode = failed ? 1 : 0;
