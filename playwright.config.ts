import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
    { name: 'firefox', use: devices['Desktop Firefox'] },
    { name: 'webkit', use: devices['Desktop Safari'] },
  ],
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
