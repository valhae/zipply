import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  axe,
  connect,
  downloads,
  openTabs,
  saved,
  sent,
  sha,
  skipWithoutWebRTC,
  status,
  typeHeard,
  verify,
  words,
} from './webrtc';

// Each test uses its own private room for isolation, except the multi-file test, which discovers
// the receiver in the public lobby.

const CHUNK = 65_536; // payload size at Chromium/Firefox maxMessageSize (P3-01)

// Heavy (real WebRTC, SHA-256 of every chunk, up to 50 MiB): one at a time per file, longer timeout.
test.describe.configure({ mode: 'default', timeout: 90_000 });

test.beforeEach(async ({ page }, testInfo) => skipWithoutWebRTC(page, testInfo));

test('multi-file transfer with edge sizes is byte-exact', async ({ page }) => {
  const { sender, receiver, receiverName } = await openTabs(page, { lobby: true });
  const files = [
    { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    { name: 'one.bin', mimeType: 'application/octet-stream', buffer: randomBytes(1) },
    { name: 'chunk.bin', mimeType: 'application/octet-stream', buffer: randomBytes(CHUNK) },
    { name: 'chunk+1.bin', mimeType: 'application/octet-stream', buffer: randomBytes(CHUNK + 1) },
    { name: 'Ünïcødé 📚.txt', mimeType: 'text/plain', buffer: Buffer.from('héllo\0world') },
  ];
  await (
    await connect(sender, receiver, receiverName, files)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  const w = await words(sender, receiver);
  expect(await sent(sender)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
  expect(await axe(receiver)).toEqual([]);

  await typeHeard(sender, w.receiver);
  expect(await sent(sender)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
  await typeHeard(receiver, w.sender);
  const incoming = receiver.getByRole('dialog', { name: 'Incoming files' });
  await expect(incoming.getByRole('listitem')).toHaveCount(files.length);
  expect(await axe(receiver)).toEqual([]);
  expect((await sent(sender)).payloadBytes).toBe(0);

  await incoming.getByRole('button', { name: 'Accept files' }).click();
  await downloads(receiver, files);
  await expect(status(sender)).toContainText('The receiver verified every file');
});

test('random 50 MiB file is byte-exact', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { sender, receiver, receiverName } = await openTabs(page);
  const buffer = randomBytes(50 * 1024 * 1024);
  const path = testInfo.outputPath('random-50MiB.bin');
  await writeFile(path, buffer);
  await (
    await connect(sender, receiver, receiverName, path)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await downloads(receiver, [{ name: 'random-50MiB.bin', buffer }]);
});

test('rejecting the connection sends no manifest and no payload', async ({ page }) => {
  const { sender, receiver, receiverName } = await openTabs(page);
  const request = await connect(sender, receiver, receiverName, {
    name: 'secret.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  });
  await expect(request).not.toContainText('secret.txt');
  await request.getByRole('button', { name: 'Reject connection' }).click();
  await expect(status(sender)).toContainText('declined the connection');
  expect(await sent(sender)).toEqual({ manifestBytes: 0, payloadBytes: 0, controls: [] });
});

test('a verification mismatch sends no manifest and no payload', async ({ page }) => {
  const { sender, receiver, receiverName } = await openTabs(page);
  await (
    await connect(sender, receiver, receiverName, {
      name: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  const w = await words(sender, receiver);
  await typeHeard(sender, w.receiver);
  await receiver.getByRole('button', { name: 'Mismatch — cancel' }).click();
  await expect(status(receiver)).toContainText('did not match');
  await expect(status(sender)).toContainText('connection was lost');
  expect(await sent(sender)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
  expect(await sent(receiver)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
});

test('rejecting the files sends no payload', async ({ page }) => {
  const { sender, receiver, receiverName } = await openTabs(page);
  await (
    await connect(sender, receiver, receiverName, {
      name: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await receiver.getByRole('button', { name: 'Reject files' }).click();
  await expect(status(sender)).toContainText('rejected the files');
  expect((await sent(sender)).payloadBytes).toBe(0);
});

test('the receiver can cancel mid-transfer and both sides stop', async ({ page }, testInfo) => {
  const { sender, receiver, receiverName } = await openTabs(page);
  const path = testInfo.outputPath('cancel-20MiB.bin');
  await writeFile(path, randomBytes(20 * 1024 * 1024));
  await (
    await connect(sender, receiver, receiverName, path)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await expect(receiver.getByRole('progressbar', { name: 'Transfer progress' })).toBeVisible();
  await receiver.getByRole('button', { name: 'Cancel transfer' }).click();
  await expect(status(receiver)).toContainText('Transfer canceled');
  await expect(status(sender)).toContainText('Transfer canceled');
  const before = (await sent(sender)).payloadBytes;
  await sender.waitForTimeout(500);
  expect((await sent(sender)).payloadBytes).toBe(before);
  expect(before).toBeLessThan(20 * 1024 * 1024);
});

test('hostile names show as text and active files are saved inert (P5-08)', async ({ page }) => {
  const { sender, receiver, receiverName } = await openTabs(page);
  const files = [
    ['<img src=x onerror="window.__xss=1">.html', 'text/html', '<script>window.__xss=2</script>'],
    [
      'image.svg',
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=3"/>',
    ],
    ['script.js', 'application/javascript', 'window.__xss=4'],
    ['\u202Etxt.exe', 'text/plain', 'bidi override'],
    ['bell\u0007.txt', 'text/plain', 'control character'],
    ['../../etc/passwd', 'text/plain', 'path traversal'],
    ['CON.txt', 'text/plain', 'reserved device name'],
  ].map(([name, mimeType, text]) => ({
    name: name!,
    mimeType: mimeType!,
    buffer: Buffer.from(text!),
  }));
  await (
    await connect(sender, receiver, receiverName, files)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  const incoming = receiver.getByRole('dialog', { name: 'Incoming files' });
  await expect(incoming.getByRole('listitem')).toHaveCount(files.length);
  await expect(incoming.locator('img, svg image, script, iframe, object')).toHaveCount(0);
  await expect(incoming).toContainText('img src=x onerror=');
  await incoming.getByRole('button', { name: 'Accept files' }).click();

  await expect(status(receiver)).toContainText('Every file passed its integrity check');
  const got = saved.get(receiver)!;
  await expect.poll(() => got.length).toBe(files.length);
  const pagesBefore = page.context().pages().length;
  for (const [i, d] of got.entries()) {
    // Saved byte-for-byte under a sanitized name; nothing was opened or run in the app's origin.
    expect(d.suggestedFilename()).not.toMatch(/[<>/\\:\p{Cc}\p{Cf}]/u);
    expect(sha(await readFile((await d.path())!))).toBe(sha(files[i]!.buffer));
  }
  expect(got.map((d) => d.suggestedFilename())).toContain('_CON.txt');
  expect(page.context().pages().length).toBe(pagesBefore);
  expect(new URL(receiver.url()).pathname).toBe('/');
  expect(await receiver.evaluate(() => '__xss' in window)).toBe(false);
});
