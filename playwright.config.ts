import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const WEBRTC = /(transfer|webrtc-spike)\.spec\.ts$/;
const ENGINES = [
  ['chromium', 'Desktop Chrome'],
  ['firefox', 'Desktop Firefox'],
  ['webkit', 'Desktop Safari'],
] as const;
// On GitHub runners Firefox could not connect even within one page (2026-10-17); the likely cause is
// unresolvable `.local` (mDNS) host candidates, so CI Firefox uses raw host IPs. Local runs keep
// browser defaults, so the mDNS path stays covered there.
const CI_FIREFOX = {
  launchOptions: {
    firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false },
  },
};

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
    {
      name: `${name}-webrtc`,
      use: { ...devices[device], ...(CI && name === 'firefox' ? CI_FIREFOX : {}) },
      testMatch: WEBRTC,
      workers: 1,
      dependencies: ENGINES.map(([ui]) => ui),
    },
  ]),
  webServer: [
    {
      command: 'npm run dev -w @zipply/web -- --strictPort --port 5173',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
    },
    {
      command:
        'npm run build -w @zipply/web && npm run preview -w @zipply/web -- --strictPort --port 4173',
      url: 'http://localhost:4173',
      reuseExistingServer: !CI,
    },
  ],
});
