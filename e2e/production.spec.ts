import { readFile, readdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://localhost:4173' });

test('production build makes no third-party requests and loads self-hosted fonts', async ({
  page,
}) => {
  const foreign: string[] = [];
  const fonts: number[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).hostname !== 'localhost') foreign.push(r.url());
  });
  page.on('response', (r) => {
    if (r.url().endsWith('.woff2')) fonts.push(r.status());
  });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    ['15px "Geist"', '11px "Geist Mono"', '48px "Geist Pixel Square"'].map((f) =>
      document.fonts.check(f),
    ),
  );
  expect(foreign).toEqual([]);
  expect(loaded).toEqual([true, true, true]);
  expect(fonts.length).toBeGreaterThanOrEqual(3);
  expect(fonts.every((s) => s === 200)).toBe(true);
});

test('production build ignores demo fixtures and never fabricates peers', async ({ page }) => {
  // With the signaling service unreachable the page must show Offline and no one, demo URL or not.
  await page.routeWebSocket(/\/ws(\/|$)/, (ws) => ws.close());
  await page.goto('/?demo=few&connection=online');
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Offline', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('radar-marker')).toHaveCount(0);
  await expect(page.getByTestId('radar-sweep')).toHaveCount(0);
  await expect(page.getByText('No one is discoverable here right now.')).toBeVisible();
});

test('production bundle contains no dev-only demo fixtures', async () => {
  const dir = 'apps/web/dist/assets';
  const scripts = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const file of scripts) {
    const js = await readFile(`${dir}/${file}`, 'utf8');
    expect(js).not.toContain('Pixel 9');
    expect(js).not.toContain('demo-a1');
  }
});

test('security headers and CSP are served, and the app runs under them (P5-08)', async ({
  page,
}) => {
  const { headers } = JSON.parse(await readFile('apps/web/vercel.json', 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const expected = headers.find((h) => h.source === '/(.*)')!.headers;
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  const response = (await page.goto('/'))!;
  const got = response.headers();
  for (const { key, value } of expected) expect(got[key.toLowerCase()]).toBe(value);
  expect(got['content-security-policy']).toContain("frame-ancestors 'none'");

  const meta = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(meta).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'; /);
  expect(meta).toContain("connect-src 'self' ws://localhost:8787;");

  // Signaling, fonts and styles all work under the policy, with no violation.
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Invisible', {
    timeout: 20_000,
  });
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);

  // An injected inline script (the XSS case) does not run.
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.head.append(s);
    return 'injected' in window || '__injected' in window;
  });
  expect(ran).toBe(false);
});
