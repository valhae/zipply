import { expect, test, type Page } from '@playwright/test';

// Online discovery through the local signaling Worker (`wrangler dev`, started by playwright.config).
// No WebRTC is involved, so this runs on every engine. Other tests share the public lobby, so peers
// are always identified by their random display name.

const badge = (p: Page) => p.getByRole('banner').getByRole('status');
const people = (p: Page) => p.getByRole('list', { name: 'Discoverable people' });
const nameOf = (p: Page) => p.getByRole('textbox', { name: 'Display name' }).inputValue();

async function online(page: Page, url = '/') {
  const p = await page.context().newPage();
  await p.goto(url);
  // A live WebSocket handshake with the local Worker; slow when the machine is loaded.
  await expect(badge(p)).toHaveText('Invisible', { timeout: 20_000 });
  return p;
}

const toggle = (p: Page) => p.getByRole('switch', { name: 'Discoverable' }).click();

test('a peer appears and disappears live as it changes visibility or leaves (P4-03/P4-08)', async ({
  page,
}) => {
  const alice = await online(page);
  const bob = await online(page);
  const name = await nameOf(alice);
  await expect(people(bob).getByRole('button', { name })).toHaveCount(0);

  await toggle(alice);
  await expect(badge(alice)).toHaveText('Visible');
  await expect(people(bob).getByRole('button', { name })).toBeVisible();

  await toggle(alice);
  await expect(people(bob).getByRole('button', { name })).toHaveCount(0);

  await toggle(alice);
  await expect(people(bob).getByRole('button', { name })).toBeVisible();
  await alice.close();
  await expect(people(bob).getByRole('button', { name })).toHaveCount(0);
});

test('a chosen display name is what others see', async ({ page }) => {
  const alice = await online(page);
  const bob = await online(page);
  const name = `Mar${Date.now() % 100_000}`;
  await alice.getByRole('button', { name: 'Edit name' }).click();
  await alice.getByLabel('Display name').fill(name);
  await alice.getByRole('button', { name: 'Save name' }).click();
  await expect(badge(alice)).toHaveText('Invisible', { timeout: 20_000 }); // reconnected
  await toggle(alice);
  await expect(people(bob).getByRole('button', { name })).toBeVisible();
});

test('names are unique among visible people: a duplicate stays hidden with a message', async ({
  page,
}) => {
  const watcher = await online(page);
  const alice = await online(page);
  await toggle(alice);
  const taken = await nameOf(alice);
  const named = people(watcher).getByRole('button', { name: new RegExp(`^${taken} `, 'i') });
  await expect(named).toHaveCount(1);

  const bob = await online(page);
  await toggle(bob);
  await bob.getByRole('button', { name: 'Edit name' }).click();
  await bob.getByLabel('Display name').fill(taken.toLowerCase());
  await bob.getByRole('button', { name: 'Save name' }).click();
  await expect(bob.getByRole('alert')).toContainText('already uses this name', { timeout: 20_000 });
  await expect(bob.getByRole('switch', { name: 'Discoverable' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(named).toHaveCount(1); // still only Alice
});

test('private rooms are separate from the lobby and from each other (P4-06)', async ({ page }) => {
  const host = await online(page);
  await host.getByRole('button', { name: 'Create private room' }).click();
  const link = await host.getByLabel('Room link').inputValue();
  expect(new URL(link).hash).toMatch(/^#room=[A-Za-z0-9_-]{27}$/);
  await toggle(host);
  const name = await nameOf(host);

  const guest = await online(page, link);
  await expect(people(guest).getByRole('button', { name })).toBeVisible();
  await expect(
    people(guest).getByRole('button', { name }).locator('svg[data-icon="lock"]'),
  ).toBeVisible();
  const outsider = await online(page);
  await expect(
    outsider.getByText('No one is discoverable here right now.').or(people(outsider)),
  ).toBeVisible();
  await expect(people(outsider).getByRole('button', { name })).toHaveCount(0);

  await host.getByRole('button', { name: 'Leave room' }).click();
  await expect(people(guest).getByRole('button', { name })).toHaveCount(0);
});

test('an expired room link is explained instead of silently joining the lobby', async ({
  page,
}) => {
  const expired = Buffer.alloc(20);
  expired.writeUInt32BE(1, 16); // expiry: minute 1 of 1970
  await page.goto(`/#room=${expired.toString('base64url')}`);
  await expect(page.getByRole('alert')).toContainText('invalid or has expired');
  await page.getByRole('button', { name: 'Leave room' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create private room' })).toBeVisible();
});

test.describe('discovery unavailable (P4-09)', () => {
  test('repeated failures show a retry that recovers once the service is back', async ({
    page,
  }) => {
    let blocked = true;
    await page.routeWebSocket(/\/ws(\/|$)/, (ws) => {
      if (blocked) return ws.close();
      ws.connectToServer();
    });
    await page.goto('/');
    const alert = page.getByRole('alert').filter({ hasText: 'Discovery temporarily unavailable' });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(badge(page)).toHaveText('Offline');
    blocked = false;
    await alert.getByRole('button', { name: 'Retry now' }).click();
    await expect(badge(page)).toHaveText('Invisible');
    await expect(alert).toHaveCount(0);
  });

  test('SERVER_BUSY (room full or quota) is reported as unavailable', async ({ page }) => {
    await page.routeWebSocket(/\/ws(\/|$)/, (ws) => {
      ws.send(JSON.stringify({ version: 1, type: 'error', payload: { code: 'SERVER_BUSY' } }));
      ws.close({ code: 1013 });
    });
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('Discovery temporarily unavailable');
  });
});
