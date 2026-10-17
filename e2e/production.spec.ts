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
