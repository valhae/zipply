import { expect, test } from '@playwright/test';

test('theme follows the system by default and persists an explicit choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByTitle('Light').click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
});

test('stored dark theme applies before the app script runs (no flash)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('zipply-theme', 'dark'));
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('peer dialog opens from the keyboard, closes on Escape, and returns focus', async ({
  page,
}) => {
  await page.goto('/?demo=few');
  const peer = page.getByRole('button', { name: /Pixel 9/ });
  await peer.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Pixel 9' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Request connection' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(peer).toBeFocused();
});

// Opened via keyboard: Safari does not focus buttons on mouse click, so there is nothing to return to.
test('visibility help dialog closes with its button and returns focus', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'What does this share' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Visibility' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('radar mirrors the list and caps markers', async ({ page }) => {
  await page.goto('/?demo=many');
  await expect(page.getByRole('list').getByRole('button')).toHaveCount(30);
  await expect(page.getByTestId('radar-marker')).toHaveCount(24);
  await expect(page.getByText('+6 more in the list')).toBeVisible();
});

test('reduced motion stops the radar sweep', async ({ page }) => {
  await page.goto('/?demo=few');
  const sweep = page.getByTestId('radar-sweep');
  const name = () => sweep.evaluate((el) => getComputedStyle(el).animationName);
  expect(await name()).toBe('sweep');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await name()).toBe('none');
});

test('decorative animation pauses while the tab is hidden', async ({ page }) => {
  await page.goto('/?demo=few');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-page-hidden', '');
  const state = await page
    .getByTestId('radar-sweep')
    .evaluate((el) => getComputedStyle(el).animationPlayState);
  expect(state).toBe('paused');
});

test('orientation change keeps the open dialog and visibility', async ({ page, browserName }) => {
  test.skip(
    browserName === 'firefox',
    'Headless Firefox on Windows crashes on resize below 1280px',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=few');
  const toggle = page.getByRole('switch', { name: 'Discoverable' });
  await toggle.click();
  await page.getByRole('button', { name: /Pixel 9/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Pixel 9' });
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('status reports discoverability once online', async ({ page }) => {
  await page.goto('/?demo=few');
  const badge = page.getByRole('banner').getByRole('status');
  await expect(badge).toHaveText('Invisible');
  await page.getByRole('switch', { name: 'Discoverable' }).click();
  await expect(badge).toHaveText('Visible');
});
