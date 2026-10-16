import { expect, test, type Page } from '@playwright/test';

// P3-01 feasibility findings (SECURITY_DECISIONS SD-02 (a)–(e)), run in each engine against the real
// sas.ts served by the Vite dev server. Two RTCPeerConnections in one page, no network beyond loopback.

declare global {
  interface Window {
    __pair: (
      a: RTCPeerConnection,
      b: RTCPeerConnection,
      edit?: (sdp: string) => string,
    ) => Promise<{ da: RTCDataChannel; db: RTCDataChannel; open: boolean }>;
  }
}

const SAS = '/src/features/connection/sas.ts';

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    // Connects a (offerer) and b with a negotiated DataChannel; `edit` may rewrite b's answer SDP.
    window.__pair = async (a, b, edit = (s) => s) => {
      a.onicecandidate = (e) => void (e.candidate && b.addIceCandidate(e.candidate));
      b.onicecandidate = (e) => void (e.candidate && a.addIceCandidate(e.candidate));
      const da = a.createDataChannel('x', { negotiated: true, id: 0 });
      const db = b.createDataChannel('x', { negotiated: true, id: 0 });
      da.binaryType = db.binaryType = 'arraybuffer';
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription!);
      await b.setLocalDescription();
      await a.setRemoteDescription({ type: 'answer', sdp: edit(b.localDescription!.sdp) });
      const open = await new Promise<boolean>((resolve) => {
        if (da.readyState === 'open') return resolve(true);
        da.onopen = () => resolve(true);
        setTimeout(() => resolve(false), 15_000);
      });
      return { da, db, open };
    };
  });
  await page.goto('/');
  const rtc = await page.evaluate(() => 'RTCPeerConnection' in window);
  test.skip(!rtc, `${testInfo.project.name}: this Playwright build has no WebRTC`);
});

const finding = (page: Page, name: string, value: unknown) =>
  console.log(
    `[P3-01] ${page.context().browser()?.browserType().name()} ${name}: ${JSON.stringify(value)}`,
  );

test('(a) sha-256 fingerprints parse identically from local and remote descriptions', async ({
  page,
}) => {
  const r = await page.evaluate(async (url) => {
    const { parseFingerprints, toB64url } = await import(/* @vite-ignore */ url);
    const cert = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
    } as EcKeyGenParams);
    const a = new RTCPeerConnection({ certificates: [cert] });
    const b = new RTCPeerConnection();
    const { open } = await window.__pair(a, b);
    const key = (sdp?: string) => (parseFingerprints(sdp ?? '') ?? []).map(toB64url).join('.');
    const certFp = cert.getFingerprints().find((f) => f.algorithm === 'sha-256')?.value ?? '';
    const lines = a
      .currentLocalDescription!.sdp.split(/\r?\n/)
      .filter((l) => l.startsWith('a=fingerprint:'));
    const result = {
      open,
      aLocal: key(a.currentLocalDescription?.sdp),
      bRemote: key(b.currentRemoteDescription?.sdp),
      bLocal: key(b.currentLocalDescription?.sdp),
      aRemote: key(a.currentRemoteDescription?.sdp),
      certMatches:
        key(`a=fingerprint:sha-256 ${certFp.toUpperCase()}`) ===
        key(a.currentLocalDescription?.sdp),
      fingerprintLines: lines.map((l) => l.split(' ')[0]),
    };
    a.close();
    b.close();
    return result;
  }, SAS);
  finding(page, 'fingerprints', { lines: r.fingerprintLines, certMatches: r.certMatches });
  expect(r.open).toBe(true);
  expect(r.aLocal).not.toBe('');
  expect(r.bLocal).not.toBe('');
  expect(r.aLocal).toBe(r.bRemote);
  expect(r.bLocal).toBe(r.aRemote);
  expect(r.certMatches).toBe(true);
});

// Computes the SAS digest each endpoint would show, from its own local/remote descriptions.
async function sasOf(page: Page, setup: 'direct' | 'mitm') {
  return page.evaluate(
    async ({ url, setup }) => {
      const m = await import(/* @vite-ignore */ url);
      const connId = m.randomBytes(16);
      const nO = m.randomBytes(16);
      const nA = m.randomBytes(16);
      const cO = await m.commit(connId, nO);
      const digest = async (pc: RTCPeerConnection, role: 'O' | 'A') => {
        const local = m.parseFingerprints(pc.currentLocalDescription!.sdp);
        const remote = m.parseFingerprints(pc.currentRemoteDescription!.sdp);
        const [fpO, fpA] = role === 'O' ? [local, remote] : [remote, local];
        const d = await m.sasDigest({ connId, cO, nO, nA, fpO, fpA });
        return { d: m.toB64url(d), phrase: m.phrase(d).join(' ') };
      };
      const alice = new RTCPeerConnection();
      const bob = new RTCPeerConnection();
      if (setup === 'direct') {
        await window.__pair(alice, bob);
        return { alice: await digest(alice, 'O'), bob: await digest(bob, 'A') };
      }
      // MITM relay: alice ↔ m1 and m2 ↔ bob are separate DTLS sessions; the relay even forwards the
      // honest nonces, so only the fingerprints differ.
      const m1 = new RTCPeerConnection();
      const m2 = new RTCPeerConnection();
      const left = await window.__pair(alice, m1);
      const right = await window.__pair(m2, bob);
      left.db.onmessage = (e) => right.da.send(e.data);
      right.da.onmessage = (e) => left.db.send(e.data);
      const relayed = await new Promise((resolve) => {
        right.db.onmessage = (e) => resolve(e.data);
        left.da.send('through the relay');
      });
      return { alice: await digest(alice, 'O'), bob: await digest(bob, 'A'), relayed };
    },
    { url: SAS, setup },
  );
}

test('(c) unchanged path: both endpoints derive the same phrase', async ({ page }) => {
  const r = await sasOf(page, 'direct');
  expect(r.alice.d).toBe(r.bob.d);
  expect(r.alice.phrase.split(' ')).toHaveLength(6);
});

test('(b) a relaying MITM yields different phrases on the two ends', async ({ page }) => {
  const r = await sasOf(page, 'mitm');
  finding(page, 'mitm', {
    relayWorks: r.relayed === 'through the relay',
    samePhrase: r.alice.phrase === r.bob.phrase,
  });
  expect(r.relayed).toBe('through the relay');
  expect(r.alice.d).not.toBe(r.bob.d);
  expect(r.alice.phrase).not.toBe(r.bob.phrase);
});

test('(b) a substituted fingerprint without terminating DTLS never opens the channel', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const r = await page.evaluate(async () => {
    const other = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
    } as EcKeyGenParams);
    const fake = other
      .getFingerprints()
      .find((f) => f.algorithm === 'sha-256')!
      .value!.toUpperCase();
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    const { open } = await window.__pair(a, b, (sdp) =>
      sdp.replace(/a=fingerprint:sha-256 \S+/g, `a=fingerprint:sha-256 ${fake}`),
    );
    const state = a.connectionState;
    a.close();
    b.close();
    return { open, state };
  });
  finding(page, 'substituted-fingerprint', r);
  expect(r.open).toBe(false);
});

test('(d) restartIce keeps the fingerprints and the DataChannel', async ({ page }) => {
  const r = await page.evaluate(async (url) => {
    const { parseFingerprints, toB64url } = await import(/* @vite-ignore */ url);
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    const { da, db } = await window.__pair(a, b);
    const key = () =>
      [a.currentLocalDescription, a.currentRemoteDescription]
        .map((d) => (parseFingerprints(d!.sdp) ?? []).map(toB64url).join('.'))
        .join('|');
    const ufrag = () => /a=ice-ufrag:(\S+)/.exec(a.currentLocalDescription!.sdp)?.[1];
    const before = { fp: key(), ufrag: ufrag() };
    a.restartIce();
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription!);
    const echoed = await new Promise((resolve) => {
      db.onmessage = (e) => resolve(e.data);
      da.send('after restart');
      setTimeout(() => resolve(null), 10_000);
    });
    return {
      sameFp: key() === before.fp,
      ufragChanged: ufrag() !== before.ufrag,
      open: da.readyState,
      echoed,
    };
  }, SAS);
  finding(page, 'restartIce', r);
  expect(r).toEqual({ sameFp: true, ufragChanged: true, open: 'open', echoed: 'after restart' });
});

test('(e) maxMessageSize is recorded and one full chunk frame arrives intact', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    const { da, db } = await window.__pair(a, b);
    const frame = new Uint8Array(65_536 + 70).map((_, i) => i % 251);
    const got = await new Promise<ArrayBuffer>((resolve) => {
      db.onmessage = (e) => resolve(e.data as ArrayBuffer);
      da.send(frame);
    });
    const back = new Uint8Array(got);
    return {
      maxMessageSize: a.sctp?.maxMessageSize ?? null,
      intact: back.length === frame.length && back.every((x, i) => x === frame[i]),
    };
  });
  finding(page, 'maxMessageSize', r.maxMessageSize);
  expect(r.intact).toBe(true);
  expect(r.maxMessageSize).toBeGreaterThanOrEqual(65_536 + 70);
});
