import AxeBuilder from '@axe-core/playwright';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Two tabs of the dev-only harness (?harness) talk over BroadcastChannel signaling and a real
// RTCPeerConnection. Every DataChannel send is counted, so "0 manifest / 0 payload bytes" is measured
// at the channel, not inferred from the UI.

declare global {
  interface Window {
    __sent: { manifestBytes: number; payloadBytes: number; controls: string[] };
  }
}

const CHUNK = 65_536; // payload size at Chromium/Firefox maxMessageSize (P3-01)

// Heavy (real WebRTC, SHA-256 of every chunk, up to 50 MiB): one at a time per file, longer timeout.
test.describe.configure({ mode: 'default', timeout: 90_000 });

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto('/');
  const rtc = await page.evaluate(() => 'RTCPeerConnection' in window);
  test.skip(
    !rtc,
    `${testInfo.project.name}: this Playwright build has no WebRTC (see PHASE_STATUS)`,
  );
});

async function openTabs(page: Page) {
  const context = page.context();
  await context.addInitScript(() => {
    window.__sent = { manifestBytes: 0, payloadBytes: 0, controls: [] };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
      if (typeof data === 'string') {
        const t = (JSON.parse(data) as { t: string }).t;
        window.__sent.controls.push(t);
        if (t === 'manifest') window.__sent.manifestBytes += data.length;
      } else {
        window.__sent.payloadBytes += (data as ArrayBuffer).byteLength;
      }
      return send.call(this, data as ArrayBufferView<ArrayBuffer>);
    };
  });
  const sender = await context.newPage();
  const receiver = await context.newPage();
  await sender.goto('/?harness');
  await receiver.goto('/?harness');
  await expect(sender.getByRole('heading', { name: 'Dev harness' })).toBeVisible();
  await expect(receiver.getByRole('heading', { name: 'Dev harness' })).toBeVisible();
  return { sender, receiver };
}

type Files = Parameters<Page['setInputFiles']>[1];

async function connect(sender: Page, receiver: Page, files: Files) {
  await sender.getByLabel('Files to send').setInputFiles(files);
  await sender.getByRole('button', { name: 'Request connection' }).click();
  const request = receiver.getByRole('dialog', { name: 'Connection request' });
  await expect(request).toBeVisible();
  return request;
}

async function verify(sender: Page, receiver: Page) {
  const words = async (p: Page) => {
    const dialog = p.getByRole('dialog', { name: 'Verification required' });
    await expect(dialog.getByRole('listitem')).toHaveCount(6, { timeout: 20_000 });
    return dialog.getByRole('listitem').allTextContents();
  };
  const [a, b] = [await words(sender), await words(receiver)];
  expect(a).toEqual(b);
  return a;
}

const sent = (p: Page) => p.evaluate(() => window.__sent);
const axe = async (p: Page) =>
  (await new AxeBuilder({ page: p }).analyze()).violations.map(
    (v) => `${v.impact} ${v.id}: ${v.help}`,
  );
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function downloads(receiver: Page, expected: { name: string; buffer: Buffer }[]) {
  await expect(receiver.getByRole('status')).toContainText(
    'Every file passed its integrity check',
    {
      timeout: 120_000,
    },
  );
  for (const file of expected) {
    const [download] = await Promise.all([
      receiver.waitForEvent('download'),
      receiver.getByRole('link', { name: `Save ${file.name}` }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(file.name);
    expect(sha(await readFile((await download.path())!))).toBe(sha(file.buffer));
  }
}

test('multi-file transfer with edge sizes is byte-exact', async ({ page }) => {
  const { sender, receiver } = await openTabs(page);
  const files = [
    { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    { name: 'one.bin', mimeType: 'application/octet-stream', buffer: randomBytes(1) },
    { name: 'chunk.bin', mimeType: 'application/octet-stream', buffer: randomBytes(CHUNK) },
    { name: 'chunk+1.bin', mimeType: 'application/octet-stream', buffer: randomBytes(CHUNK + 1) },
    { name: 'Ünïcødé 📚.txt', mimeType: 'text/plain', buffer: Buffer.from('héllo\0world') },
  ];
  await (
    await connect(sender, receiver, files)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  expect(await sent(sender)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
  expect(await axe(receiver)).toEqual([]);

  await sender.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'The words match' }).click();
  const incoming = receiver.getByRole('dialog', { name: 'Incoming files' });
  await expect(incoming.getByRole('listitem')).toHaveCount(files.length);
  expect(await axe(receiver)).toEqual([]);
  expect((await sent(sender)).payloadBytes).toBe(0);

  await incoming.getByRole('button', { name: 'Accept files' }).click();
  await downloads(receiver, files);
  await expect(sender.getByRole('status')).toContainText('The receiver verified every file');
});

test('random 50 MiB file is byte-exact', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { sender, receiver } = await openTabs(page);
  const buffer = randomBytes(50 * 1024 * 1024);
  const path = testInfo.outputPath('random-50MiB.bin');
  await writeFile(path, buffer);
  await (
    await connect(sender, receiver, path)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await sender.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await downloads(receiver, [{ name: 'random-50MiB.bin', buffer }]);
});

test('rejecting the connection sends no manifest and no payload', async ({ page }) => {
  const { sender, receiver } = await openTabs(page);
  const request = await connect(sender, receiver, {
    name: 'secret.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  });
  await expect(request).not.toContainText('secret.txt');
  await request.getByRole('button', { name: 'Reject connection' }).click();
  await expect(sender.getByRole('status')).toContainText('rejected the connection');
  expect(await sent(sender)).toEqual({ manifestBytes: 0, payloadBytes: 0, controls: [] });
});

test('a verification mismatch sends no manifest and no payload', async ({ page }) => {
  const { sender, receiver } = await openTabs(page);
  await (
    await connect(sender, receiver, {
      name: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await sender.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'Mismatch — cancel' }).click();
  await expect(receiver.getByRole('status')).toContainText('did not match');
  await expect(sender.getByRole('status')).toContainText('connection was lost');
  expect(await sent(sender)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
  expect(await sent(receiver)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
});

test('rejecting the files sends no payload', async ({ page }) => {
  const { sender, receiver } = await openTabs(page);
  await (
    await connect(sender, receiver, {
      name: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await sender.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'Reject files' }).click();
  await expect(sender.getByRole('status')).toContainText('rejected the files');
  expect((await sent(sender)).payloadBytes).toBe(0);
});

test('the receiver can cancel mid-transfer and both sides stop', async ({ page }, testInfo) => {
  const { sender, receiver } = await openTabs(page);
  const path = testInfo.outputPath('cancel-20MiB.bin');
  await writeFile(path, randomBytes(20 * 1024 * 1024));
  await (
    await connect(sender, receiver, path)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await sender.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'The words match' }).click();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await expect(receiver.getByRole('progressbar', { name: 'Transfer progress' })).toBeVisible();
  await receiver.getByRole('button', { name: 'Cancel transfer' }).click();
  await expect(receiver.getByRole('status')).toContainText('Transfer canceled');
  await expect(sender.getByRole('status')).toContainText('Transfer canceled');
  const before = (await sent(sender)).payloadBytes;
  await sender.waitForTimeout(500);
  expect((await sent(sender)).payloadBytes).toBe(before);
  expect(before).toBeLessThan(20 * 1024 * 1024);
});
