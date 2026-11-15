import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { contentSecurityPolicy, signalingUrlProblem } from './src/features/presence/url.ts';

// P5-08: the headers Vercel sends (vercel.json) are also served by `vite preview`, so e2e tests them.
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const securityHeaders = Object.fromEntries(vercel.headers[0]!.headers.map((h) => [h.key, h.value]));

/** Adds the build-dependent CSP as the first <meta> in <head>, hashing every inline script. */
const csp = (signalingUrl: string | undefined): Plugin => ({
  name: 'zipply-csp',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: (html) => [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: contentSecurityPolicy(
            signalingUrl,
            [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) =>
              createHash('sha256').update(m[1]!).digest('base64'),
            ),
          ),
        },
        injectTo: 'head-prepend',
      },
    ],
  },
});

/**
 * P7-02: writes dist/sw.js from ./sw.js with the precache list (every built file, index.html as
 * "/") and a version hashed from their names and contents, so any change installs a new cache.
 */
const shell = (): Plugin => {
  let outDir = '';
  return {
    name: 'zipply-shell',
    apply: 'build',
    configResolved: (c) => void (outDir = join(c.root, c.build.outDir)),
    closeBundle() {
      const files = (readdirSync(outDir, { recursive: true }) as string[])
        .map((f) => f.replaceAll('\\', '/'))
        .filter((f) => f !== 'sw.js' && statSync(join(outDir, f)).isFile())
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const data = {
        version: hash.digest('hex').slice(0, 16),
        urls: files.map((f) => (f === 'index.html' ? '/' : `/${f}`)),
      };
      const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
      writeFileSync(join(outDir, 'sw.js'), source.replace('self.__SHELL__', JSON.stringify(data)));
    },
  };
};

export default defineConfig(({ command, mode }) => {
  const url = loadEnv(mode, process.cwd(), 'VITE_').VITE_SIGNALING_URL;
  // P4-07: a build never ships plaintext ws:// signaling except to localhost (spec §38.4).
  if (command === 'build') {
    const problem = signalingUrlProblem(url);
    if (problem === 'insecure' || problem === 'invalid') {
      throw new Error(
        `VITE_SIGNALING_URL must be wss:// (ws:// only for localhost); this one is ${problem}`,
      );
    }
  }
  return {
    plugins: [react(), tailwindcss(), csp(url), shell()],
    preview: { headers: securityHeaders },
    // Unit tests never reach a signaling service, whatever the local .env says.
    test: { environment: 'jsdom', env: { VITE_SIGNALING_URL: '' } },
  };
});
