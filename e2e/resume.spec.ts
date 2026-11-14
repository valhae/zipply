import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  connect,
  downloads,
  openTabs,
  proxySignaling,
  sent,
  skipWithoutWebRTC,
  status,
  udpRelay,
  verification,
  verify,
} from './webrtc';

// P6-04 / P6-05 / P6-06 through the real app and the local Worker. A connection is broken either
// by closing the app's DataChannel from the test (deterministic, at an exact checkpoint) or by
// cutting a UDP relay that carries the real data path (a genuine network loss; Chromium only,
// because it needs raw IP host candidates).

test.describe.configure({ mode: 'default', timeout: 180_000 });
// Raw IP host candidates for the relay tests (Chromium only); other tests work with either kind.
test.use({
  launchOptions: async ({ browserName }, use) =>
    use(
      browserName === 'chromium' ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } : {},
    ),
});
test.beforeEach(async ({ page }, testInfo) => skipWithoutWebRTC(page, testInfo));

const MiB = 1024 * 1024;
const FRAME = 1 + 70 / 65_536; // payload plus chunk header

async function file(testInfo: TestInfo, name: string, size: number) {
  const buffer = randomBytes(size);
  const path = testInfo.outputPath(name);
  await writeFile(path, buffer);
  return { name, buffer, path };
}

/** A verified, accepted transfer of one file. */
async function start(
  sender: Page,
  receiver: Page,
  receiverName: string,
  f: Awaited<ReturnType<typeof file>>,
) {
  await (
    await connect(sender, receiver, receiverName, f.path)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await receiver.getByRole('button', { name: 'Accept files' }).click();
}

/** In the page (no round trip): once the receiver sent `n` checkpoint acks, close its channel. */
const breakAfterAcks = (receiver: Page, n: number) =>
  receiver.evaluate(async (n) => {
    while (window.__sent.controls.filter((t) => t === 'ack').length < n) {
      await new Promise((r) => setTimeout(r, 0));
    }
    window.__dcs.forEach((dc) => dc.close());
  }, n);

const count = (list: string[], t: string) => list.filter((x) => x === t).length;

/** The sender reconnects, the receiver accepts, both check new words. */
async function resume(sender: Page, receiver: Page) {
  await sender.getByRole('button', { name: 'Reconnect' }).click();
  const request = receiver.getByRole('dialog', { name: 'Connection request' });
  await expect(request).toContainText('paused transfer');
  await request.getByRole('button', { name: 'Accept connection' }).click();
  await expect(verification(receiver)).toContainText('new connection for the paused transfer');
  await verify(sender, receiver);
}

for (const pct of [1, 50, 99]) {
  test(`a new connection resumes at ${pct} % from the receiver's checkpoint, byte-exact (P6-05)`, async ({
    page,
  }, testInfo) => {
    const f = await file(testInfo, `resume-${pct}.bin`, 100 * MiB);
    const { sender, receiver, receiverName } = await openTabs(page);
    await start(sender, receiver, receiverName, f);
    await breakAfterAcks(receiver, pct);
    await expect(status(sender)).toContainText('Paused', { timeout: 20_000 });
    await expect(status(receiver)).toContainText('Paused');
    const before = (await sent(sender)).payloadBytes;

    await resume(sender, receiver);
    await downloads(receiver, [{ name: f.name, buffer: f.buffer }]);
    await expect(status(sender)).toContainText('The receiver verified every file');
    const after = await sent(sender);
    const resent = after.payloadBytes - before;
    // Not from zero: only what the receiver had not confirmed is sent again.
    expect(resent).toBeLessThanOrEqual((100 - pct) * MiB * FRAME);
    expect(count(after.controls, 'manifest')).toBe(1);
    expect(count(after.controls, 'resume')).toBe(1);
    testInfo.annotations.push({ type: 'resent', description: `${resent} bytes` });
  });
}

test('a signaling drop keeps the transfer: no new words, no restart (P6-04)', async ({
  page,
}, testInfo) => {
  const f = await file(testInfo, 'signaling-drop.bin', 100 * MiB);
  const proxies: Record<string, Awaited<ReturnType<typeof proxySignaling>>> = {};
  const { sender, receiver, receiverName } = await openTabs(page, {
    before: async (p, who) => (proxies[who] = await proxySignaling(p)),
  });
  await start(sender, receiver, receiverName, f);
  // P6-09: count how often the announced status line changes during the transfer.
  await receiver.evaluate(() => {
    const el = document.querySelector('[aria-labelledby="connection-heading"] [role="status"]')!;
    const w = window as unknown as { __statusChanges: number };
    w.__statusChanges = 0;
    new MutationObserver(() => w.__statusChanges++).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await receiver.evaluate(async () => {
    while (window.__sent.controls.filter((t) => t === 'ack').length < 10) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  proxies.sender!.drop();
  await expect
    .poll(() =>
      count(
        proxies.sender!.log.up.map((m) => m.type),
        'hello',
      ),
    )
    .toBe(2);
  await downloads(receiver, [{ name: f.name, buffer: f.buffer }]);

  // The server told the receiver the sender's old socket left; the open channel ignored it (D20).
  expect(proxies.receiver!.log.down.some((m) => m.type === 'cancel')).toBe(true);
  const s = await sent(sender);
  expect(count(s.controls, 'sas-confirm')).toBe(1);
  expect(count(s.controls, 'resume')).toBe(0);
  expect(s.payloadBytes).toBeLessThanOrEqual(f.buffer.length * FRAME);
  const changes = await receiver.evaluate(
    () => (window as unknown as { __statusChanges: number }).__statusChanges,
  );
  expect(changes).toBeLessThanOrEqual(2); // receiving → done, never per chunk
});

test('cancel while paused is final: no silent resume (P6-06)', async ({ page }, testInfo) => {
  const f = await file(testInfo, 'cancel-paused.bin', 40 * MiB);
  const { sender, receiver, receiverName } = await openTabs(page);
  await start(sender, receiver, receiverName, f);
  await breakAfterAcks(receiver, 10);
  await expect(status(receiver)).toContainText('Paused', { timeout: 20_000 });
  await receiver.getByRole('button', { name: 'Cancel transfer' }).click();
  await expect(status(receiver)).toContainText('Transfer canceled');
  const before = (await sent(sender)).payloadBytes;

  // The receiver no longer has the transfer. While its ended transfer is on screen, a reconnect
  // is declined automatically; after Close it is only an ordinary, unrelated request.
  await sender.getByRole('button', { name: 'Reconnect' }).click();
  const section = sender.locator('[aria-labelledby="connection-heading"]');
  await expect(section).toContainText('declined the connection');
  await expect(status(sender)).toContainText('Paused');
  await receiver.getByRole('button', { name: 'Close' }).click();
  await sender.getByRole('button', { name: 'Reconnect' }).click();
  const request = receiver.getByRole('dialog', { name: 'Connection request' });
  await expect(request).toBeVisible();
  await expect(request).not.toContainText('paused transfer');
  await request.getByRole('button', { name: 'Reject connection' }).click();
  await expect(status(sender)).toContainText('Paused');
  expect((await sent(sender)).payloadBytes).toBe(before);
});

test('cancel during the new word check ends the transfer on both sides (P6-06)', async ({
  page,
}, testInfo) => {
  const f = await file(testInfo, 'cancel-words.bin', 40 * MiB);
  const { sender, receiver, receiverName } = await openTabs(page);
  await start(sender, receiver, receiverName, f);
  await breakAfterAcks(receiver, 10);
  await expect(status(sender)).toContainText('Paused', { timeout: 20_000 });
  await sender.getByRole('button', { name: 'Reconnect' }).click();
  await receiver
    .getByRole('dialog', { name: 'Connection request' })
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await expect(verification(sender).getByRole('listitem')).toHaveCount(3, { timeout: 20_000 });
  const before = (await sent(sender)).payloadBytes;
  await sender.keyboard.press('Escape');
  await expect(status(sender)).toContainText('Transfer canceled');
  await expect(status(receiver)).toContainText('Transfer canceled');
  expect((await sent(sender)).payloadBytes).toBe(before);
});

test.describe('real network loss through a UDP relay (Chromium)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'raw IP candidates: Chromium flag only');
  });

  async function relayed(page: Page) {
    const relay = udpRelay();
    const proxies: Record<string, Awaited<ReturnType<typeof proxySignaling>>> = {};
    const tabs = await openTabs(page, {
      before: async (p, who) => (proxies[who] = await proxySignaling(p, { up: relay.rewrite })),
    });
    return { relay, proxies, ...tabs };
  }

  test('a short outage recovers by ICE restart on the same connection (P6-04)', async ({
    page,
  }, testInfo) => {
    const f = await file(testInfo, 'ice-restart.bin', 100 * MiB);
    const { relay, proxies, sender, receiver, receiverName } = await relayed(page);
    try {
      await start(sender, receiver, receiverName, f);
      await receiver.evaluate(async () => {
        while (window.__sent.controls.filter((t) => t === 'ack').length < 20) {
          await new Promise((r) => setTimeout(r, 0));
        }
      });
      relay.state.up = false;
      await sender.waitForTimeout(15_000);
      expect(proxies.sender!.log.up.filter((m) => m.type === 'offer').length).toBe(2);
      await expect(status(sender)).not.toContainText('Paused');
      relay.state.up = true;
      await downloads(receiver, [{ name: f.name, buffer: f.buffer }]);

      const offers = proxies.sender!.log.up.filter((m) => m.type === 'offer');
      expect(offers[1]!.payload.connId).toBe(offers[0]!.payload.connId);
      expect(offers[1]!.payload.cO).toBe(offers[0]!.payload.cO);
      const s = await sent(sender);
      expect(count(s.controls, 'sas-confirm')).toBe(1); // no new word check
      expect(count(s.controls, 'resume')).toBe(0);
      expect(s.payloadBytes).toBeLessThanOrEqual(f.buffer.length * FRAME);
    } finally {
      await relay.close();
    }
  });

  test('a long outage pauses; after it, a new connection resumes byte-exact (P6-05)', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const f = await file(testInfo, 'outage.bin', 100 * MiB);
    const { relay, sender, receiver, receiverName } = await relayed(page);
    try {
      await start(sender, receiver, receiverName, f);
      await receiver.evaluate(async () => {
        while (window.__sent.controls.filter((t) => t === 'ack').length < 50) {
          await new Promise((r) => setTimeout(r, 0));
        }
      });
      relay.state.up = false;
      await expect(status(sender)).toContainText('Paused', { timeout: 60_000 });
      await expect(status(receiver)).toContainText('Paused', { timeout: 60_000 });
      const before = (await sent(sender)).payloadBytes;
      relay.state.up = true;
      await resume(sender, receiver);
      await downloads(receiver, [{ name: f.name, buffer: f.buffer }]);
      expect((await sent(sender)).payloadBytes - before).toBeLessThanOrEqual(50 * MiB * FRAME);
    } finally {
      await relay.close();
    }
  });
});
