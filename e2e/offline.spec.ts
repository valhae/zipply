import { expect, test } from '@playwright/test';
import { cached, installShell, shellList } from './shell';

// P7-01 / P7-02 against the production build (`vite preview`): the dev server has no service worker.
test.use({ baseURL: 'http://localhost:4173' });

const pngSize = (b: Buffer) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;

test('the web app manifest is valid and its icons load (P7-01)', async ({ page, browserName }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = (await (await page.request.get(href!)).json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  expect(manifest).toMatchObject({ name: 'Zipply', start_url: '/', display: 'standalone' });
  for (const icon of manifest.icons) {
    const res = await page.request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    if (icon.type === 'image/png') expect(pngSize(await res.body())).toBe(icon.sizes);
  }
  expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose ?? 'any'}`)).toEqual(
    expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']),
  );
  if (browserName === 'chromium') {
    // Chrome's own installability check (Lighthouse no longer has a PWA category).
    await installShell(page);
    const cdp = await page.context().newCDPSession(page);
    const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
      installabilityErrors: { errorId: string }[];
    };
    test.info().annotations.push({
      type: 'installability',
      description: JSON.stringify(installabilityErrors),
    });
    expect(installabilityErrors).toEqual([]);
  }
});

test('after the first visit the app reloads offline from a cache holding the app shell only (P7-02)', async ({
  page,
  context,
}) => {
  await installShell(page);
  const shell = await shellList(page);
  expect(shell).toContain('/');
  expect(shell.filter((p) => p.endsWith('.js')).length).toBeGreaterThan(1); // lazy chunks too
  const before = await cached(page);
  expect(Object.keys(before)).toHaveLength(1);
  expect(Object.keys(before)[0]).toMatch(/^zipply-shell-[0-9a-f]{16}$/);
  expect(Object.values(before)[0]).toEqual(shell);

  // A same-origin request outside the shell goes to the network and is not stored.
  await page.evaluate(() => fetch('/not-in-shell?online'));
  expect(await cached(page)).toEqual(before);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'zipply' })).toBeVisible();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Offline — radar unavailable', { timeout: 20_000 });
  await alert.getByRole('button', { name: 'Try local pairing' }).click();
  // The lazily loaded pairing code (and its QR code) come from the cache too.
  await expect(page.getByRole('button', { name: 'Create pairing code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create pairing code' })).toBeDisabled();

  // Nothing else was added: no page data, no responses beyond the build's own files.
  expect(await cached(page)).toEqual(before);
  // Anything outside the shell is not answered from the cache.
  expect(
    await page.evaluate(() =>
      fetch('/not-in-shell').then(
        () => 'ok',
        () => 'failed',
      ),
    ),
  ).toBe('failed');
});
