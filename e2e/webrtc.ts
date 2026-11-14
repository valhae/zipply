import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';

// Shared by the WebRTC specs: two pages of the real app find each other through the local
// signaling Worker (`wrangler dev`) and connect over a real RTCPeerConnection. Every DataChannel
// send is counted, so "0 manifest / 0 payload bytes" is measured at the channel, not the UI.

declare global {
  interface Window {
    __sent: { manifestBytes: number; payloadBytes: number; controls: string[] };
  }
}

// GitHub-hosted WebKit offers only an mDNS host candidate that another page cannot resolve
// (spike (f) on CI: connectionState stays 'new'). Safari needs real devices anyway (R11).
const WEBKIT_CI = "CI WebKit cannot resolve another page's mDNS host candidate";

export async function skipWithoutWebRTC(page: Page, testInfo: TestInfo) {
  await page.goto('/');
  const rtc = await page.evaluate(() => 'RTCPeerConnection' in window);
  test.skip(
    !rtc,
    `${testInfo.project.name}: this Playwright build has no WebRTC (see PHASE_STATUS)`,
  );
  test.skip(!!process.env.CI && testInfo.project.name === 'webkit-webrtc', WEBKIT_CI);
}

/** A signaling frame as the app encodes it. */
export interface Frame {
  version: number;
  type: string;
  payload: Record<string, unknown>;
}
type Rewrite = (frame: Frame) => Frame | null;

/**
 * Puts a test proxy on a page's signaling WebSocket, playing a malicious or curious signaling
 * service. `up` sees client → server frames and `down` server → client frames; returning null drops
 * a frame. Every JSON frame is recorded. `inject` sends a forged frame in either direction.
 */
export async function proxySignaling(page: Page, rules: { up?: Rewrite; down?: Rewrite } = {}) {
  const log = { up: [] as Frame[], down: [] as Frame[] };
  let toPage: ((text: string) => void) | null = null;
  let toServer: ((text: string) => void) | null = null;
  const pipe =
    (dir: 'up' | 'down', rewrite: Rewrite | undefined, send: (t: string) => void) =>
    (message: string | Buffer) => {
      const text = message.toString();
      if (!text.startsWith('{')) return send(text); // heartbeat ping/pong
      const frame = JSON.parse(text) as Frame;
      log[dir].push(frame);
      const out = rewrite ? rewrite(frame) : frame;
      if (out) send(JSON.stringify(out));
    };
  await page.routeWebSocket(/\/ws(\/|$)/, (ws) => {
    const server = ws.connectToServer();
    toPage = (t) => ws.send(t);
    toServer = (t) => server.send(t);
    ws.onMessage(pipe('up', rules.up, toServer));
    server.onMessage(pipe('down', rules.down, toPage));
  });
  return {
    log,
    inject(dir: 'up' | 'down', type: string, payload: Record<string, unknown>) {
      const text = JSON.stringify({ version: 1, type, payload });
      (dir === 'up' ? toServer : toPage)!(text);
    },
  };
}

/** `before` runs on each page before it loads, e.g. to put a proxy on its signaling socket. */
export async function openTabs(
  page: Page,
  {
    lobby = false,
    before,
  }: { lobby?: boolean; before?: (p: Page, who: 'sender' | 'receiver') => Promise<unknown> } = {},
) {
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
  await before?.(sender, 'sender');
  await sender.goto('/');
  let url = '/';
  if (!lobby) {
    await sender.getByRole('button', { name: 'Create private room' }).click();
    url = await sender.getByLabel('Room link').inputValue();
  }
  const receiver = await context.newPage();
  const got: Download[] = [];
  saved.set(receiver, got);
  receiver.on('download', (d) => got.push(d));
  await before?.(receiver, 'receiver');
  await receiver.goto(url);
  for (const p of [sender, receiver]) {
    // Live handshake with the local Worker; slow when the machine is loaded.
    await expect(p.getByRole('banner').getByRole('status')).toHaveText('Invisible', {
      timeout: 20_000,
    });
  }
  await receiver.getByRole('switch', { name: 'Discoverable' }).click();
  const receiverName = await receiver.getByRole('textbox', { name: 'Display name' }).inputValue();
  return { sender, receiver, receiverName };
}

export type Files = Parameters<Page['setInputFiles']>[1];

export async function connect(sender: Page, receiver: Page, receiverName: string, files: Files) {
  await sender
    .getByRole('list', { name: 'Discoverable people' })
    .getByRole('button', { name: receiverName })
    .click();
  const details = sender.getByRole('dialog', { name: receiverName });
  await details.getByLabel('Files to send').setInputFiles(files);
  await details.getByRole('button', { name: 'Request connection' }).click();
  const request = receiver.getByRole('dialog', { name: 'Connection request' });
  await expect(request).toBeVisible();
  return request;
}

/** The connection section's own status line (the header badge and live region are separate). */
export const status = (p: Page) =>
  p.locator('[aria-labelledby="connection-heading"]').getByRole('status');

export const verification = (p: Page) => p.getByRole('dialog', { name: 'Verification required' });

/** The three words each device shows its user to read aloud (D19). */
export async function words(sender: Page, receiver: Page) {
  const say = async (p: Page) => {
    const items = verification(p).getByRole('listitem');
    await expect(items).toHaveCount(3, { timeout: 20_000 });
    return items.allTextContents();
  };
  return { sender: await say(sender), receiver: await say(receiver) };
}

/** A user types the words they heard the other person read. */
export async function typeHeard(p: Page, heard: string[]) {
  await verification(p).getByRole('textbox', { name: 'Words you hear' }).fill(heard.join(' '));
  await verification(p).getByRole('button', { name: 'Check words' }).click();
}

export async function verify(sender: Page, receiver: Page) {
  const w = await words(sender, receiver);
  await typeHeard(sender, w.receiver);
  await typeHeard(receiver, w.sender);
}

export const sent = (p: Page) => p.evaluate(() => window.__sent);
/**
 * axe once finite animations are done: mid-way through a dialog's 200 ms fade-in its text is
 * semi-transparent and fails contrast (this failed CI on a slower runner). Infinite ones (radar) are left.
 */
export async function axe(p: Page) {
  await p.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  return (await new AxeBuilder({ page: p }).analyze()).violations.map(
    (v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  );
}
export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Verified files are saved automatically (owner decision, 2026-10-17): no clicks here.
export const saved = new WeakMap<Page, Download[]>();

export async function downloads(receiver: Page, expected: { name: string; buffer: Buffer }[]) {
  await expect(status(receiver)).toContainText('Every file passed its integrity check', {
    timeout: 120_000,
  });
  const got = saved.get(receiver)!;
  await expect.poll(() => got.length).toBe(expected.length);
  expect(got.map((d) => d.suggestedFilename())).toEqual(expected.map((f) => f.name));
  for (const [i, file] of expected.entries()) {
    expect(sha(await readFile((await got[i]!.path())!))).toBe(sha(file.buffer));
  }
}
