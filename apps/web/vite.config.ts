import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    plugins: [react(), tailwindcss(), csp(url)],
    preview: { headers: securityHeaders },
    // Unit tests never reach a signaling service, whatever the local .env says.
    test: { environment: 'jsdom', env: { VITE_SIGNALING_URL: '' } },
  };
});
