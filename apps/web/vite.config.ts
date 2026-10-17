import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { signalingUrlProblem } from './src/features/presence/url.ts';

export default defineConfig(({ command, mode }) => {
  // P4-07: a build never ships plaintext ws:// signaling except to localhost (spec §38.4).
  if (command === 'build') {
    const url = loadEnv(mode, process.cwd(), 'VITE_').VITE_SIGNALING_URL;
    const problem = signalingUrlProblem(url);
    if (problem === 'insecure' || problem === 'invalid') {
      throw new Error(
        `VITE_SIGNALING_URL must be wss:// (ws:// only for localhost); this one is ${problem}`,
      );
    }
  }
  return {
    plugins: [react(), tailwindcss()],
    // Unit tests never reach a signaling service, whatever the local .env says.
    test: { environment: 'jsdom', env: { VITE_SIGNALING_URL: '' } },
  };
});
