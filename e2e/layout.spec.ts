import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const VIEWPORTS = [
  [320, 568],
  [360, 800],
  [390, 844],
  [430, 932],
  [667, 375],
  [844, 390],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
] as const;

async function expectReachable(page: Page, name: string, el: Locator) {
  await el.scrollIntoViewIfNeeded();
  await expect(el, name).toBeVisible();
  const box = await el.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, name).not.toBeNull();
  expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(width + 1);
}

for (const [width, height] of VIEWPORTS) {
  test.describe(`${width}x${height}`, () => {
    test.use({ viewport: { width, height } });
    for (const demo of ['many', 'tricky']) {
      test(`?demo=${demo}: no horizontal overflow, controls reachable`, async ({ page }) => {
        await page.goto(`/?demo=${demo}`);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
        await expectReachable(page, 'theme control', page.getByRole('group', { name: 'Theme' }));
        await expectReachable(
          page,
          'visibility switch',
          page.getByRole('switch', { name: 'Discoverable' }),
        );
        await expectReachable(page, 'radar', page.getByTestId('radar'));
        const peers = page.getByRole('list').getByRole('button');
        await expectReachable(page, 'first peer', peers.first());
        await expectReachable(page, 'last peer', peers.last());
      });
    }
  });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ] as const) {
    test.describe(`${width}x${height}`, () => {
      test.use({ viewport: { width, height } });
      test(`axe: ${scheme} has no violations`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.goto('/?demo=few');
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(violations.map((v) => `${v.impact} ${v.id}: ${v.help}`)).toEqual([]);
      });
    });
  }

  test(`axe: ${scheme} with peer dialog open has no violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto('/?demo=few');
    await page.getByRole('button', { name: /Pixel 9/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.impact} ${v.id}: ${v.help}`)).toEqual([]);
  });
}
