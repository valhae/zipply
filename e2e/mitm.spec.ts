import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  connect,
  downloads,
  openTabs,
  proxySignaling,
  sent,
  skipWithoutWebRTC,
  status,
  typeHeard,
  verification,
  verify,
  words,
  type Frame,
} from './webrtc';

// P5-01..P5-05 (spec §38.7): a test proxy on the sender's signaling socket plays a malicious
// signaling service. It sees and rewrites every frame of the real app talking to the real Worker.
// Only synthetic files are used. The release claim tested: a signaling MITM is detected when both
// users check the words, and nothing about the files leaves the sender before that.

declare global {
  interface Window {
    mitm: {
      received: string[];
      answerSender(sdp: string): Promise<{ sdp: string; nA: string }>;
      offerReceiver(): Promise<{ connId: string; sdp: string; cO: string }>;
      receiverAnswered(sdp: string): Promise<void>;
      ice(leg: Leg, candidate: RTCIceCandidateInit): Promise<void>;
    };
    mitmIce(leg: Leg, candidate: RTCIceCandidateInit): void;
  }
}
type Leg = 'toSender' | 'toReceiver';

test.describe.configure({ mode: 'default', timeout: 90_000 });
test.beforeEach(async ({ page }, testInfo) => skipWithoutWebRTC(page, testInfo));

const FILE = { name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') };
const blocked = (p: Page) =>
  expect(sent(p)).resolves.toMatchObject({ manifestBytes: 0, payloadBytes: 0 });

/** Types the words the other user reads, until the device gives up (3 tries, then fail closed). */
async function typeUntilClosed(p: Page, heard: string[]) {
  for (let i = 0; i < 3; i++) await typeHeard(p, heard);
  await expect(status(p)).toContainText('the words did not match');
}

/**
 * The attacker's own browser page: one RTCPeerConnection towards each victim, each with its own
 * DTLS certificate, speaking just enough of the DataChannel protocol to show both victims words.
 */
async function attackerPage(page: Page, onIce: (leg: Leg, c: RTCIceCandidateInit) => void) {
  const m = await page.context().newPage();
  await m.exposeFunction('mitmIce', onIce);
  await m.goto('/');
  await m.evaluate(() => {
    const b64 = (u: Uint8Array) =>
      btoa(String.fromCharCode(...u))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const pcs = { toSender: new RTCPeerConnection(), toReceiver: new RTCPeerConnection() };
    const received: string[] = [];
    const channels = Object.fromEntries(
      Object.entries(pcs).map(([leg, pc]) => {
        pc.onicecandidate = (e) => e.candidate && window.mitmIce(leg as Leg, e.candidate.toJSON());
        const ch = pc.createDataChannel('zipply', { negotiated: true, id: 0, ordered: true });
        ch.onmessage = (e) =>
          received.push(
            typeof e.data === 'string' ? (JSON.parse(e.data) as { t: string }).t : 'binary',
          );
        return [leg, ch];
      }),
    ) as Record<Leg, RTCDataChannel>;
    window.mitm = {
      received,
      async answerSender(sdp) {
        await pcs.toSender.setRemoteDescription({ type: 'offer', sdp });
        await pcs.toSender.setLocalDescription();
        return { sdp: pcs.toSender.localDescription!.sdp, nA: b64(rand(16)) };
      },
      async offerReceiver() {
        // Its own commitment, fixed before it sees the receiver's nonce (it has no other choice).
        const connId = rand(16);
        const nO = rand(16);
        const label = new TextEncoder().encode('zipply/sas-commit/v1');
        const cO = new Uint8Array(
          await crypto.subtle.digest('SHA-256', new Uint8Array([...label, ...connId, ...nO])),
        );
        channels.toReceiver.onopen = () =>
          channels.toReceiver.send(JSON.stringify({ v: 1, t: 'sas-reveal', nO: b64(nO) }));
        await pcs.toReceiver.setLocalDescription();
        return { connId: b64(connId), sdp: pcs.toReceiver.localDescription!.sdp, cO: b64(cO) };
      },
      async receiverAnswered(sdp) {
        await pcs.toReceiver.setRemoteDescription({ type: 'answer', sdp });
      },
      async ice(leg, candidate) {
        await pcs[leg].addIceCandidate(candidate);
      },
    };
  });
  return m;
}

test('a signaling MITM that terminates both connections is caught by the typed words', async ({
  page,
}) => {
  // Everything the attacker does is serialized, as a real relay would.
  let queue = Promise.resolve();
  const later = (fn: () => Promise<unknown>) => void (queue = queue.then(fn).then(() => {}));
  const ids = { requestId: '', toSender: '', toReceiver: '' };
  let proxy: Awaited<ReturnType<typeof proxySignaling>>;

  const { sender, receiver, receiverName } = await openTabs(page, {
    before: async (p, who) => {
      if (who === 'receiver') return;
      proxy = await proxySignaling(p, {
        up(f) {
          const pl = f.payload;
          if (f.type === 'offer') {
            ids.requestId = pl.requestId as string;
            ids.toSender = pl.connId as string;
            later(async () => {
              const answer = await m.evaluate(
                (sdp) => window.mitm.answerSender(sdp),
                pl.sdp as string,
              );
              proxy.inject('down', 'answer', {
                requestId: ids.requestId,
                connId: ids.toSender,
                ...answer,
              });
              const offer = await m.evaluate(() => window.mitm.offerReceiver());
              ids.toReceiver = offer.connId;
              proxy.inject('up', 'offer', { requestId: ids.requestId, ...offer });
            });
            return null;
          }
          if (f.type === 'ice-candidate') {
            const c = pl.candidate as RTCIceCandidateInit;
            later(() => m.evaluate((c) => window.mitm.ice('toSender', c), c));
            return null;
          }
          return f;
        },
        down(f) {
          const pl = f.payload;
          if (f.type === 'answer') {
            later(() => m.evaluate((sdp) => window.mitm.receiverAnswered(sdp), pl.sdp as string));
            return null;
          }
          if (f.type === 'ice-candidate') {
            const c = pl.candidate as RTCIceCandidateInit;
            later(() => m.evaluate((c) => window.mitm.ice('toReceiver', c), c));
            return null;
          }
          return f;
        },
      });
    },
  });
  // Queued, so each leg's candidates follow the description they belong to.
  const m = await attackerPage(page, (leg, candidate) =>
    later(async () => {
      const frame = { requestId: ids.requestId, connId: ids[leg], candidate };
      proxy.inject(leg === 'toSender' ? 'down' : 'up', 'ice-candidate', frame);
    }),
  );

  await (
    await connect(sender, receiver, receiverName, FILE)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  // Both victims reach verification over their own DTLS connection to the attacker.
  const w = await words(sender, receiver);
  await blocked(sender);

  // Honest users each type what the other one reads aloud: neither device accepts it.
  await typeUntilClosed(sender, w.receiver);
  await typeUntilClosed(receiver, w.sender);
  await blocked(sender);
  await blocked(receiver);
  const controls = (await sent(sender)).controls;
  expect(controls).not.toContain('sas-confirm');
  expect(controls).not.toContain('manifest');
  expect(await m.evaluate(() => window.mitm.received)).not.toContain('manifest');
  expect(await m.evaluate(() => window.mitm.received)).not.toContain('binary');
});

async function substituted(page: Page, rules: Parameters<typeof proxySignaling>[1]) {
  const tabs = await openTabs(page, {
    before: async (p, who) => who === 'sender' && proxySignaling(p, rules),
  });
  await (
    await connect(tabs.sender, tabs.receiver, tabs.receiverName, FILE)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  return tabs;
}

const replace = (f: Frame, type: string, patch: (p: Record<string, string>) => object) =>
  f.type === type
    ? { ...f, payload: { ...f.payload, ...patch(f.payload as Record<string, string>) } }
    : f;

test('a substituted answer nonce gives the two devices different words', async ({ page }) => {
  const forged = 'AAAAAAAAAAAAAAAAAAAAAA';
  const { sender, receiver } = await substituted(page, {
    down: (f) => replace(f, 'answer', () => ({ nA: forged })),
  });
  const w = await words(sender, receiver);
  // Both devices reject what their user heard; the first to give up closes the shared connection.
  await typeHeard(receiver, w.sender);
  await expect(verification(receiver).getByRole('alert')).toContainText('do not match');
  await typeUntilClosed(sender, w.receiver);
  await expect(status(receiver)).toContainText('connection was lost');
  await blocked(sender);
  await blocked(receiver);
});

test('a substituted commitment is caught before any words are shown', async ({ page }) => {
  const { sender, receiver } = await substituted(page, {
    up: (f) => replace(f, 'offer', () => ({ cO: 'A'.repeat(43) })),
  });
  await expect(status(receiver)).toContainText('could not be completed safely', {
    timeout: 20_000,
  });
  await expect(verification(receiver)).toBeHidden();
  await expect(status(sender)).toContainText('connection was lost');
  await blocked(sender);
});

test('a substituted DTLS fingerprint never opens the channel or shows words', async ({ page }) => {
  const other = Array.from({ length: 32 }, () => 'AB').join(':');
  const { sender, receiver } = await substituted(page, {
    down: (f) =>
      replace(f, 'answer', (p) => ({
        sdp: p.sdp!.replace(/a=fingerprint:sha-256 \S+/g, `a=fingerprint:sha-256 ${other}`),
      })),
  });
  // DTLS rejects the forged certificate, so the session ends without ever reaching the words.
  await expect(status(sender)).toContainText('connection was lost', { timeout: 45_000 });
  await expect(verification(sender)).toBeHidden();
  await expect(verification(receiver)).toBeHidden();
  await blocked(sender);
});

/** Starts a request with a recording proxy on the sender, and gets both pages to the words. */
async function proxiedToWords(page: Page) {
  let proxy!: Awaited<ReturnType<typeof proxySignaling>>;
  const tabs = await openTabs(page, {
    before: async (p, who) => who === 'sender' && (proxy = await proxySignaling(p)),
  });
  await (
    await connect(tabs.sender, tabs.receiver, tabs.receiverName, FILE)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await words(tabs.sender, tabs.receiver);
  return { ...tabs, proxy };
}

test('trust flags forged by the signaling service change nothing (P5-02)', async ({ page }) => {
  const { sender, receiver, proxy } = await proxiedToWords(page);
  const requestId = proxy.log.up.find((f) => f.type === 'connection-request')!.payload.requestId;
  proxy.inject('down', 'peer-verified', { requestId, verified: true });
  proxy.inject('down', 'sas-confirm', { d: 'A'.repeat(43) });
  proxy.inject('down', 'connection-response', { requestId, accept: true, verified: true });
  await sender.waitForTimeout(500);
  // Still waiting for the user's own check; nothing about the files was sent.
  await expect(verification(sender).getByRole('textbox', { name: 'Words you hear' })).toBeVisible();
  await blocked(sender);
  // The honest path still works afterwards: the forgeries were simply ignored.
  await verify(sender, receiver);
  await expect(receiver.getByRole('dialog', { name: 'Incoming files' })).toBeVisible();
});

test('a replayed answer is refused by the browser and closes the connection (P5-04)', async ({
  page,
}) => {
  const { sender, proxy } = await proxiedToWords(page);
  const answer = proxy.log.down.find((f) => f.type === 'answer')!;
  proxy.inject('down', 'answer', answer.payload);
  await expect(status(sender)).toContainText('connection was lost', { timeout: 20_000 });
  await blocked(sender);
});

test('an offer replayed after the request ended is refused by the server (P5-04)', async ({
  page,
}) => {
  const { receiver, proxy } = await proxiedToWords(page);
  const offer = proxy.log.up.find((f) => f.type === 'offer')!;
  await receiver.close();
  // Replay only once the server has cancelled the pair (it tells the sender), not before.
  await expect.poll(() => proxy.log.down.some((f) => f.type === 'cancel')).toBe(true);
  proxy.inject('up', 'offer', offer.payload);
  await expect
    .poll(() => proxy.log.down.filter((f) => f.type === 'error').map((f) => f.payload.code))
    .toContain('REQUEST_EXPIRED');
});

test('signaling never carries file names, sizes, types or counts (P5-07)', async ({ page }) => {
  const logs: Frame[][] = [];
  const name = 'private-tax-return-2026.pdf';
  const buffer = randomBytes(4321);
  const { sender, receiver, receiverName } = await openTabs(page, {
    before: async (p) => {
      const { log } = await proxySignaling(p);
      logs.push(log.up, log.down);
    },
  });
  await (
    await connect(sender, receiver, receiverName, { name, mimeType: 'application/pdf', buffer })
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await downloads(receiver, [{ name, buffer }]);

  const frames = logs.flat();
  expect(frames.map((f) => f.type)).toEqual(
    expect.arrayContaining(['connection-request', 'offer', 'answer']),
  );
  const text = JSON.stringify(frames);
  for (const secret of [name, 'private-tax', 'application/pdf']) expect(text).not.toContain(secret);
  const walk = (v: unknown): [string, unknown][] =>
    v && typeof v === 'object'
      ? Object.entries(v).flatMap(([k, x]) => [[k, x] as [string, unknown], ...walk(x)])
      : [];
  const fields = frames.flatMap((f) => walk(f.payload));
  const FILE_KEYS = ['files', 'name', 'size', 'mimeType', 'count', 'manifest', 'manifestDigest'];
  expect(fields.filter(([k]) => FILE_KEYS.includes(k))).toEqual([]);
  expect(fields.filter(([, v]) => v === buffer.length)).toEqual([]);
});
