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

test('production build ignores demo fixtures and is truthfully offline', async ({ page }) => {
  await page.goto('/?demo=few&connection=online');
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Offline');
  await expect(page.getByTestId('radar-marker')).toHaveCount(0);
  await expect(page.getByTestId('radar-sweep')).toHaveCount(0);
  await expect(page.getByText('No one is discoverable here right now.')).toBeVisible();
});

test('production build contains no dev transfer harness', async ({ page }) => {
  await page.goto('/?harness');
  await expect(page.getByRole('heading', { level: 1, name: 'zipply' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dev harness' })).toHaveCount(0);
  const dir = 'apps/web/dist/assets';
  const scripts = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const file of scripts) {
    const js = await readFile(`${dir}/${file}`, 'utf8');
    expect(js).not.toContain('zipply-dev-harness');
    expect(js).not.toContain('Dev harness');
  }
});
