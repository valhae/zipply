import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// P6-07 / P6-08: transfer benchmarks, run on demand with `npm run bench` (not part of `npm run e2e`).
// Results are written to docs/benchmarks/ with the environment they were measured in.
export default defineConfig({
  ...base,
  testMatch: /\.bench\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  projects: [{ name: 'chromium-bench', use: devices['Desktop Chrome'] }],
  webServer: [base.webServer ?? []].flat().slice(0, 2), // signaling + dev server
});
