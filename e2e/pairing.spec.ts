import { expect, test, type Download, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'uqr';
import { cached, installShell, shellList } from './shell';
import { axe, countSends, sent, sha, skipWithoutWebRTC, verify } from './webrtc';

// P7-03 / P7-04: two pages with no signaling at all pair by carrying codes, then transfer through
// the same verified session as online mode. Production build, so the pages reload offline from
// the service worker. On real devices the LAN route decides (docs/OFFLINE-MODE.md).
test.use({ baseURL: 'http://localhost:4173' });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const section = (p: Page) => p.locator('[aria-labelledby="pairing-heading"]');
const codeOf = (p: Page, label: string) =>
  expect
    .poll(() => section(p).getByRole('textbox', { name: label, exact: true }).inputValue(), {
      timeout: 20_000,
    })
    .toMatch(/^zipply1\./)
    .then(() => section(p).getByRole('textbox', { name: label, exact: true }).inputValue());

/**
 * Both pages load once online (installing the shell) and reload with the network off. Playwright's
 * offline emulation also stops new WebRTC connections (probe, 2026-11-15), which a LAN without
 * internet does not, so it is then lifted while routes keep every HTTP request and WebSocket
 * (signaling) failing: no internet, loopback still there.
 */
async function offlinePages(page: Page) {
  const context = page.context();
  await countSends(context);
  await installShell(page);
  const sender = page;
  const receiver = await context.newPage();
  await receiver.goto('/');
  await context.setOffline(true);
  for (const p of [sender, receiver]) {
    await p.reload();
    const alert = p.getByRole('alert');
    await expect(alert).toContainText('Offline — radar unavailable', { timeout: 20_000 });
    await alert.getByRole('button', { name: 'Try local pairing' }).click();
    await expect(section(p).getByRole('button', { name: 'Create answer' })).toBeVisible();
  }
  await context.route('**/*', (route) => route.abort());
  await context.routeWebSocket(/./, (ws) => ws.close());
  await context.setOffline(false);
  return { sender, receiver };
}

test('two offline pages pair with codes and transfer byte-exact; nothing leaves before both checks', async ({
  page,
}, testInfo) => {
  await skipWithoutWebRTC(page, testInfo);
  const { sender, receiver } = await offlinePages(page);
  const got: Download[] = [];
  receiver.on('download', (d) => got.push(d));
  const file = {
    name: 'offline.bin',
    mimeType: 'application/octet-stream',
    buffer: randomBytes(3 << 20),
  };

  await section(sender).getByLabel('Files to send').setInputFiles(file);
  await section(sender).getByRole('button', { name: 'Create pairing code' }).click();
  const offer = await codeOf(sender, 'Your pairing code');
  testInfo.annotations.push({ type: 'offer code length', description: String(offer.length) });

  // Wrong codes are refused with an explanation and start nothing.
  await section(receiver).getByLabel('Code from the sending device').fill('hello');
  await section(receiver).getByRole('button', { name: 'Create answer' }).click();
  await expect(section(receiver).getByRole('alert')).toHaveText(
    'That is not a Zipply pairing code.',
  );
  await section(sender).getByLabel('Answer code from the receiving device').fill(offer);
  await section(sender).getByRole('button', { name: 'Connect' }).click();
  await expect(section(sender).getByRole('alert')).toHaveText(
    'That code belongs on the other device.',
  );

  await section(receiver).getByLabel('Code from the sending device').fill(offer);
  await section(receiver).getByRole('button', { name: 'Create answer' }).click();
  const answer = await codeOf(receiver, 'Your answer code');
  testInfo.annotations.push({ type: 'answer code length', description: String(answer.length) });
  await section(sender).getByLabel('Answer code from the receiving device').fill(answer);
  await section(sender).getByRole('button', { name: 'Connect' }).click();

  // Connected, but nothing about the files has left the sender before the word check.
  await expect(receiver.getByRole('dialog', { name: 'Verification required' })).toBeVisible({
    timeout: 30_000,
  });
  expect(await sent(sender)).toMatchObject({ manifestBytes: 0, payloadBytes: 0 });
  expect(await axe(receiver)).toEqual([]);
  await verify(sender, receiver);
  const incoming = receiver.getByRole('dialog', { name: 'Incoming files' });
  await expect(incoming).toBeVisible();
  expect((await sent(sender)).payloadBytes).toBe(0);
  await incoming.getByRole('button', { name: 'Accept files' }).click();

  await expect(section(receiver).getByRole('status')).toContainText(
    'Every file passed its integrity check',
    { timeout: 60_000 },
  );
  await expect.poll(() => got.length).toBe(1);
  expect(got[0]!.suggestedFilename()).toBe(file.name);
  expect(sha(await readFile((await got[0]!.path())!))).toBe(sha(file.buffer));

  // The codes (SDP and addresses) were never stored: the cache still holds the shell only, and
  // neither page kept them in storage.
  const shell = await shellList(receiver);
  for (const p of [sender, receiver]) {
    expect(Object.values(await cached(p))).toEqual([shell]);
    const stored = await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toContain('zipply1.');
  }
});

test('the QR code on screen decodes to exactly the pairing code (P7-04)', async ({
  page,
}, testInfo) => {
  await skipWithoutWebRTC(page, testInfo);
  await page.goto('/');
  await page.getByRole('region', { name: 'Local pairing' }).getByRole('button').click();
  await section(page)
    .getByLabel('Files to send')
    .setInputFiles({
      name: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });
  await section(page).getByRole('button', { name: 'Create pairing code' }).click();
  const code = await codeOf(page, 'Your pairing code');
  await expect(
    section(page).getByRole('img', { name: 'QR code of your pairing code' }),
  ).toBeVisible();
  expect(await axe(page)).toEqual([]);
  const png = await section(page)
    .getByRole('img', { name: 'QR code of your pairing code' })
    .screenshot();
  // Decode the pixels with jsQR (the scanner's fallback decoder) in a blank page.
  const blank = await page.context().newPage();
  await blank.addScriptTag({ path: createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js') });
  const decoded = await blank.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    [c.width, c.height] = [img.width, img.height];
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    return (
      window as unknown as {
        jsQR: (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
      }
    ).jsQR(data, c.width, c.height)?.data;
  }, png.toString('base64'));
  // A boolean, so a failure never prints the code (it holds network addresses) into CI logs.
  expect(decoded === code, 'the QR decodes to the pairing code').toBe(true);
});

// Chromium's fake camera plays a Y4M file; it is written after launch, before the camera starts.
const CAMERA = join(tmpdir(), `zipply-qr-${process.pid}.y4m`);
// Chromium only: a fake camera through command-line switches (they affect getUserMedia only). The
// default headless shell has no camera capture at all (NotSupportedError, probe 2026-11-15), so
// these tests run the full Chromium build in headless mode, which `playwright install chromium` adds.
test.use({
  permissions: async ({ browserName }, use) => use(browserName === 'chromium' ? ['camera'] : []),
  launchOptions: [
    async ({ browserName }, use) =>
      use(
        browserName === 'chromium'
          ? {
              channel: 'chromium',
              args: [
                '--use-fake-device-for-media-stream',
                `--use-file-for-fake-video-capture=${CAMERA}`,
              ],
            }
          : {},
      ),
    { scope: 'worker' },
  ],
});

/** One 640×480 YUV 4:2:0 frame showing `text` as a QR code, dark on white. */
async function writeQrVideo(text: string) {
  const { size, data } = encode(text, { ecc: 'L', border: 4 });
  const [w, h] = [640, 480];
  const scale = Math.floor(460 / size);
  const [ox, oy] = [(w - size * scale) >> 1, (h - size * scale) >> 1];
  const y = Buffer.alloc(w * h, 235);
  for (let r = 0; r < size * scale; r++) {
    for (let c = 0; c < size * scale; c++) {
      if (data[Math.floor(r / scale)]![Math.floor(c / scale)]) y[(oy + r) * w + ox + c] = 16;
    }
  }
  const chroma = Buffer.alloc((w / 2) * (h / 2) * 2, 128);
  await writeFile(
    CAMERA,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F5:1 Ip A1:1 C420jpeg\nFRAME\n`), y, chroma]),
  );
}

test.describe('scanning with a camera', () => {
  test('a scanned QR fills the field and creates nothing by itself (P7-04)', async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'fake camera files are a Chromium switch');
    await skipWithoutWebRTC(page, testInfo);
    const code = `zipply1.${randomBytes(600).toString('base64url')}`;
    await writeQrVideo(code);
    await page.getByRole('region', { name: 'Local pairing' }).getByRole('button').click();
    await section(page).getByRole('button', { name: 'Scan QR code' }).click();
    const field = section(page).getByLabel('Code from the sending device');
    await expect(field).toHaveValue(code, { timeout: 20_000 });
    await expect(page.getByRole('dialog', { name: 'Scan QR code' })).toBeHidden();
    // Scanning used no button: no answer code was made and the camera is off again.
    await expect(section(page).getByRole('textbox', { name: 'Your answer code' })).toHaveCount(0);
    await expect(section(page).getByRole('button', { name: 'Create answer' })).toBeEnabled();
    // Using this made-up code would have raised "damaged or incomplete"; nothing was used.
    await expect(section(page).getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector('video'))).toBeNull();
  });
});
