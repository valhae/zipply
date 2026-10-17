import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const SIGNALING = 'ws://localhost:8787/ws';
const TEST_ORIGINS = 'http://localhost:5173,http://localhost:4173';
const WEBRTC = /(transfer|webrtc-spike)\.spec\.ts$/;
const ENGINES = [
  ['chromium', 'Desktop Chrome'],
  ['firefox', 'Desktop Firefox'],
  ['webkit', 'Desktop Safari'],
] as const;
// On GitHub runners Firefox gathered no ICE candidates at all, even with mDNS obfuscation off or
// loopback candidates on (spike (f), 2026-10-17; cause unknown). Its WebRTC specs run locally only.

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  // CPU-heavy WebRTC specs run after the UI suite, one test per engine at a time, so they don't
  // starve page loads (Firefox `page.goto` timed out under contention).
  projects: ENGINES.flatMap(([name, device]) => [
    { name, use: devices[device], testIgnore: WEBRTC },
    ...(CI && name === 'firefox'
      ? []
      : [
          {
            name: `${name}-webrtc`,
            use: devices[device],
            testMatch: WEBRTC,
            workers: 1,
            dependencies: ENGINES.map(([ui]) => ui),
          },
        ]),
  ]),
  webServer: [
    {
      // Local signaling Worker; the test origin allowlist is passed explicitly (never from .dev.vars).
      command: `npm run dev -w @zipply/signaling -- --port 8787 --var ALLOWED_ORIGINS:${TEST_ORIGINS}`,
      url: 'http://localhost:8787/healthz',
      reuseExistingServer: !CI,
    },
    {
      command: 'npm run dev -w @zipply/web -- --strictPort --port 5173',
      env: { VITE_SIGNALING_URL: SIGNALING },
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
    },
    {
      command:
        'npm run build -w @zipply/web && npm run preview -w @zipply/web -- --strictPort --port 4173',
      env: { VITE_SIGNALING_URL: SIGNALING },
      url: 'http://localhost:4173',
      reuseExistingServer: !CI,
    },
  ],
});
