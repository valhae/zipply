// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeChunk } from '../transfer/frames';
import { memorySink, type ReceivePlan, type Sink } from '../transfer/sinks';
import { commit, randomBytes, toB64url } from './sas';
import { createSession, type Session, type SessionOptions } from './session';

type Listener = (e: { data?: unknown }) => void;
interface FakeEnd {
  readyState: string;
  binaryType: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  sent: (string | ArrayBuffer)[];
  /** Binary frames still delivered; then the link is dead and nothing more arrives. */
  budget?: number;
  peer: FakeEnd;
  addEventListener(t: string, fn: Listener): void;
  removeEventListener(t: string, fn: Listener): void;
  emit(t: string, e?: { data?: unknown }): void;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

// In-memory DataChannel pair: ordered, asynchronous delivery; records what each end sent.
function channelPair() {
  const make = () => {
    const listeners: Record<string, Set<Listener>> = {};
    const end: FakeEnd = {
      readyState: 'open',
      binaryType: 'arraybuffer',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      sent: [] as (string | ArrayBuffer)[],
      peer: null as unknown as FakeEnd,
      addEventListener: (t, fn) => void (listeners[t] ??= new Set()).add(fn),
      removeEventListener: (t, fn) => void listeners[t]?.delete(fn),
      emit: (t, e = {}) => listeners[t]?.forEach((fn) => fn(e)),
      send(data: string | ArrayBuffer) {
        if (end.readyState !== 'open') throw new Error('InvalidStateError');
        end.sent.push(data);
        // Once a frame is lost the link is dead: nothing after it arrives either.
        if (end.budget !== undefined && (typeof data !== 'string' || end.budget < 0)) {
          if (end.budget-- <= 0) return;
        }
        setTimeout(() => end.peer.readyState === 'open' && end.peer.emit('message', { data }), 0);
      },
      // Like RTCDataChannel: already-queued messages are still delivered, then both ends close.
      close() {
        if (end.readyState !== 'open') return;
        end.readyState = 'closing';
        setTimeout(() => {
          for (const e of [end, end.peer]) {
            e.readyState = 'closed';
            e.emit('close');
          }
        }, 1);
      },
    };
    return end;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b] as const;
}

const fp = (byte: string) => `a=fingerprint:sha-256 ${`${byte}:`.repeat(31)}${byte}`;
// Generous: each fake hop is a timer, and Windows timers tick at ~15.6 ms.
const settle = () => new Promise((r) => setTimeout(r, 150));
const manifests = (end: FakeEnd) =>
  end.sent.filter((m) => typeof m === 'string' && m.includes('"manifest"')).length;
const payloads = (end: FakeEnd) => end.sent.filter((m) => typeof m !== 'string').length;
const random = (n: number) => Uint8Array.from({ length: n }, () => (Math.random() * 256) | 0);

/** The link dies: both ends close at once and nothing in flight arrives. */
const cut = (end: FakeEnd) => {
  for (const e of [end, end.peer]) {
    if (e.readyState === 'closed') continue;
    e.readyState = 'closed';
    e.emit('close');
  }
};
async function waitFor(check: () => boolean, ms = 10_000) {
  for (const until = Date.now() + ms; !check();) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sessions: Session[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

async function setup(
  over: {
    files?: File[];
    cO?: Uint8Array;
    answerSdp?: string;
    plan?: ReceivePlan;
    sink?: Sink;
    tuning?: SessionOptions['tuning'];
    resumeTtlMs?: number;
  } = {},
) {
  const [oEnd, aEnd] = channelPair();
  const connId = randomBytes(16);
  const nO = randomBytes(16);
  const nA = randomBytes(16);
  const cO = await commit(connId, nO);
  const common = {
    maxMessageSize: () => 1024 + 70,
    onClose: () => {},
    tuning: over.tuning,
    resumeTtlMs: over.resumeTtlMs,
  };
  const offerer = createSession({
    ...common,
    role: 'offerer',
    channel: oEnd as unknown as RTCDataChannel,
    secrets: { connId, cO, nO, nA },
    sdp: () => ({ local: fp('AA'), remote: fp('BB') }),
    files: over.files ?? [new File([random(10)], 'a.bin')],
  } satisfies SessionOptions);
  const answerer = createSession({
    ...common,
    role: 'answerer',
    channel: aEnd as unknown as RTCDataChannel,
    secrets: { connId, cO: over.cO ?? cO, nA },
    sdp: () => ({ local: fp('BB'), remote: over.answerSdp ?? fp('AA') }),
    receive: {
      plan: async () => over.plan ?? { kind: 'memory' },
      open: async () => over.sink ?? memorySink(),
    },
  });
  sessions.push(offerer, answerer);
  await settle();
  return { offerer, answerer, oEnd, aEnd };
}

type Users = { offerer: Session; answerer: Session };
/** What each user hears: the words the other device shows (D19). */
const heard = (s: Users) => ({
  offerer: s.answerer.getSnapshot().say!.join(' '),
  answerer: s.offerer.getSnapshot().say!.join(' '),
});
const verify = async (s: Users) => {
  const h = heard(s);
  s.offerer.checkWords(h.offerer);
  s.answerer.checkWords(h.answerer);
  await settle();
};

describe('session: happy path', () => {
  it('each side shows only the three words its user reads aloud', async () => {
    const s = await setup();
    const o = s.offerer.getSnapshot();
    const a = s.answerer.getSnapshot();
    expect(o.say).toHaveLength(3);
    expect(a.say).toHaveLength(3);
    expect(a.say).not.toEqual(o.say);
    // The half a user must type is never in the snapshot the UI renders.
    expect(Object.keys(o)).not.toContain('phrase');
    expect([o.state, a.state]).toEqual(['verifying', 'verifying']);
    expect([o.attemptsLeft, a.attemptsLeft]).toEqual([3, 3]);
    expect(a.manifest).toBeNull();
    expect(manifests(s.oEnd) + payloads(s.oEnd)).toBe(0);
  });

  it('transfers several files byte-exact after both confirmations and acceptance', async () => {
    const data = [random(0), random(1), random(1024), random(1025), random(5000)];
    const names = ['empty', 'one', 'chunk', 'chunk+1', 'many'];
    const s = await setup({ files: data.map((d, i) => new File([d], names[i]!)) });
    const h = heard(s);
    expect(s.offerer.checkWords(h.offerer)).toBe('ok');
    await settle();
    expect(manifests(s.oEnd)).toBe(0); // only one side confirmed
    expect(s.answerer.checkWords(h.answerer)).toBe('ok');
    await settle();

    const a = s.answerer.getSnapshot();
    expect(a.state).toBe('offered');
    expect(a.manifest?.files.map((f) => f.name)).toEqual(names);
    expect(payloads(s.oEnd)).toBe(0); // nothing before Accept

    s.answerer.accept();
    await settle();
    await settle();
    expect(s.offerer.getSnapshot().state).toBe('completed');
    const done = s.answerer.getSnapshot();
    expect(done.state).toBe('completed');
    expect(done.downloads.map((d) => d.name)).toEqual(names);
    for (const [i, d] of done.downloads.entries()) {
      expect(new Uint8Array(await d.blob.arrayBuffer())).toEqual(data[i]);
      expect(d.url).toMatch(/^blob:/);
    }
  });
});

describe('session: consent and verification fail closed', () => {
  it('reject files → no payload, both rejected', async () => {
    const s = await setup();
    await verify(s);
    s.answerer.reject();
    await settle();
    expect(s.offerer.getSnapshot().state).toBe('rejected');
    expect(s.answerer.getSnapshot().state).toBe('rejected');
    expect(payloads(s.oEnd)).toBe(0);
  });

  it('mismatch → failed, connection closed, no manifest or payload', async () => {
    const s = await setup();
    s.answerer.mismatch();
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'mismatch' });
    expect(s.offerer.getSnapshot().state).toBe('failed');
    expect(s.oEnd.readyState).toBe('closed');
    expect(manifests(s.oEnd) + payloads(s.oEnd)).toBe(0);
  });

  it('a terminal state purges the words (SD-02 step 8)', async () => {
    const s = await setup();
    const h = heard(s);
    expect(s.answerer.getSnapshot().say).not.toBeNull();
    s.answerer.mismatch();
    await settle();
    expect(s.answerer.getSnapshot().say).toBeNull();
    expect(s.offerer.getSnapshot().say).toBeNull();
    // The hidden half is gone too: the right words no longer verify anything.
    expect(s.answerer.checkWords(h.answerer)).toBe('ignored');
  });

  it('a wrong entry leaves two tries; the right words then verify', async () => {
    const s = await setup();
    const h = heard(s);
    expect(s.answerer.checkWords('zoo zoo zoo')).toBe('wrong');
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'verifying', attemptsLeft: 2 });
    expect(s.answerer.checkWords(h.answerer)).toBe('ok');
    expect(s.answerer.getSnapshot().localConfirmed).toBe(true);
  });

  it('three wrong entries fail closed as a mismatch and close the connection', async () => {
    const s = await setup();
    s.answerer.checkWords('zoo zoo zoo');
    s.answerer.checkWords('zoo zoo zoo');
    expect(s.answerer.checkWords('zoo zoo zoo')).toBe('failed');
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'mismatch' });
    expect(s.offerer.getSnapshot().state).toBe('failed');
    expect(s.oEnd.readyState).toBe('closed');
    expect(manifests(s.oEnd) + payloads(s.oEnd)).toBe(0);
  });

  it('typing the words your own device shows does not verify', async () => {
    const s = await setup();
    const own = s.answerer.getSnapshot().say!.join(' ');
    expect(s.answerer.checkWords(own)).toBe('wrong');
    expect(s.answerer.getSnapshot().localConfirmed).toBe(false);
  });

  it('substituted fingerprints (MITM) → the words heard never match on either side', async () => {
    const s = await setup({ answerSdp: fp('CC') });
    for (let i = 0; i < 3; i++) await verify(s);
    expect(s.offerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'mismatch' });
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'mismatch' });
    expect(manifests(s.oEnd) + payloads(s.oEnd)).toBe(0);
  });

  it('commitment mismatch → answerer fails before showing a phrase', async () => {
    const s = await setup({ cO: randomBytes(32) });
    expect(s.answerer.getSnapshot()).toMatchObject({
      state: 'failed',
      reason: 'commitment',
      say: null,
    });
  });

  it('a manifest with no suitable sink is rejected automatically before any payload', async () => {
    const plan = { kind: null, reason: 'no-sink' } as const;
    const s = await setup({ files: [new File([random(2000)], 'big')], plan });
    await verify(s);
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'rejected', plan });
    expect(s.offerer.getSnapshot().state).toBe('rejected');
    expect(payloads(s.oEnd)).toBe(0);
  });

  it('a chunk before acceptance closes the connection', async () => {
    const s = await setup();
    await verify(s);
    s.oEnd.send(new ArrayBuffer(100));
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'protocol' });
    expect(s.aEnd.readyState).toBe('closed');
    s.answerer.accept(); // too late: terminal state absorbs it
    await settle();
    expect(s.answerer.getSnapshot().state).toBe('failed');
  });

  it.each([
    ['forged trust flag', '{"v":1,"t":"verified"}'],
    ['manifest before verification', '{"v":1,"t":"manifest"}'],
    ['not JSON', 'hello'],
  ])('%s → protocol failure', async (_, text) => {
    const s = await setup();
    s.oEnd.send(text);
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'protocol' });
  });

  it('cancel during transfer stops both sides', async () => {
    const big = random(2_000_000);
    const s = await setup({ files: [new File([big], 'big')] });
    await verify(s);
    s.answerer.accept();
    await new Promise((r) => setTimeout(r, 5));
    s.answerer.cancel();
    await settle();
    expect(s.answerer.getSnapshot().state).toBe('canceled');
    expect(s.offerer.getSnapshot().state).toBe('canceled');
    expect(payloads(s.oEnd)).toBeLessThan(Math.ceil(big.length / 1024));
  });

  it('the channel closing mid-verification fails closed', async () => {
    const s = await setup();
    s.oEnd.close();
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'closed' });
  });

  it('a lost connection fails closed', async () => {
    const s = await setup();
    await verify(s);
    s.answerer.lost();
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'closed' });
    expect(payloads(s.oEnd)).toBe(0);
  });
});

describe('session: replay (P5-04)', () => {
  const control = (end: FakeEnd, msg: object) => end.send(JSON.stringify({ v: 1, ...msg }));

  it('a confirmation carrying another digest (e.g. from an old connection) is a mismatch', async () => {
    const s = await setup();
    control(s.oEnd, { t: 'sas-confirm', d: toB64url(randomBytes(32)) });
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'mismatch' });
    expect(manifests(s.oEnd) + payloads(s.oEnd)).toBe(0);
  });

  it('a replayed confirmation after verification fails closed', async () => {
    const s = await setup();
    await verify(s);
    const confirm = s.oEnd.sent.find((m) => typeof m === 'string' && m.includes('sas-confirm'));
    s.oEnd.send(confirm as string);
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'protocol' });
    expect(payloads(s.oEnd)).toBe(0);
  });

  it('a second nonce reveal fails closed', async () => {
    const s = await setup();
    const reveal = s.oEnd.sent.find((m) => typeof m === 'string' && m.includes('sas-reveal'));
    s.oEnd.send(reveal as string);
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'protocol' });
  });
});

describe('session: consent races (P5-05)', () => {
  it('the sender cancels while the receiver reviews the files; a late Accept sends nothing', async () => {
    const s = await setup();
    await verify(s);
    expect(s.answerer.getSnapshot().state).toBe('offered');
    s.offerer.cancel();
    await settle();
    s.answerer.accept();
    await settle();
    expect(s.answerer.getSnapshot().state).toBe('canceled');
    expect(s.offerer.getSnapshot().state).toBe('canceled');
    expect(payloads(s.oEnd)).toBe(0);
    expect(s.aEnd.sent.some((m) => typeof m === 'string' && m.includes('files-accept'))).toBe(
      false,
    );
  });

  it('Accept and Cancel at the same moment: nobody completes and the sender stops', async () => {
    const s = await setup({ files: [new File([random(200_000)], 'big')] });
    await verify(s);
    s.answerer.accept();
    s.offerer.cancel();
    await settle();
    expect(s.offerer.getSnapshot().state).toBe('canceled');
    expect(s.answerer.getSnapshot().state).not.toBe('completed');
    expect(payloads(s.oEnd)).toBe(0);
  });

  it('a duplicate acceptance during the transfer fails it closed', async () => {
    const s = await setup({ files: [new File([random(2_000_000)], 'big')] });
    await verify(s);
    await s.answerer.accept();
    const accept = s.aEnd.sent.find((m) => typeof m === 'string' && m.includes('files-accept'));
    s.aEnd.send(accept as string);
    await settle();
    expect(s.offerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'protocol' });
    const after = payloads(s.oEnd);
    await settle();
    expect(payloads(s.oEnd)).toBe(after);
  });
});

// P6-03 / P6-05 / P6-06: a lost connection pauses the transfer; a new connection runs the word
// check again (D4), proves it belongs to the same transfer, and continues from the receiver's
// confirmed offset.
const CHUNK = 1024;
const frameOffsets = (end: FakeEnd) =>
  end.sent
    .filter((m): m is ArrayBuffer => typeof m !== 'string')
    .map((m) => decodeChunk(m, CHUNK)!.header.offset);

async function reconnect(s: Users) {
  const [oEnd, aEnd] = channelPair();
  const connId = randomBytes(16);
  const nO = randomBytes(16);
  const nA = randomBytes(16);
  const cO = await commit(connId, nO);
  const common = { maxMessageSize: () => CHUNK + 70, onClose: () => {} };
  const okO = s.offerer.attach({
    ...common,
    role: 'offerer',
    channel: oEnd as unknown as RTCDataChannel,
    secrets: { connId, cO, nO, nA },
    sdp: () => ({ local: fp('AA'), remote: fp('BB') }),
  });
  const okA = s.answerer.attach({
    ...common,
    role: 'answerer',
    channel: aEnd as unknown as RTCDataChannel,
    secrets: { connId, cO, nA },
    sdp: () => ({ local: fp('BB'), remote: fp('AA') }),
  });
  await settle();
  return { oEnd, aEnd, ok: okO && okA };
}

/** Starts a transfer and kills the link after `chunks` chunks reached the receiver. */
async function pausedAt(chunks: number, size = 300 * CHUNK + 17, over = {}) {
  const data = random(size);
  const s = await setup({
    files: [new File([data], 'big')],
    tuning: { ackEvery: 64 * CHUNK },
    ...over,
  });
  await verify(s);
  s.oEnd.budget = chunks;
  await s.answerer.accept();
  await waitFor(() => s.answerer.debug().confirmed === chunks * CHUNK);
  cut(s.oEnd);
  await settle();
  return { s, data };
}

describe('session: pause and resume (P6-03, P6-05)', () => {
  it.each([
    ['1 %', 3],
    ['50 %', 150],
    ['99 %', 297],
  ])('resumes at %s byte-exact from the receiver-confirmed offset', async (_, chunks) => {
    const { s, data } = await pausedAt(chunks);
    expect(s.offerer.getSnapshot().state).toBe('paused');
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'paused' });
    const at = chunks * CHUNK;
    // Sent, queued and confirmed are separate; only the receiver's confirmation counts.
    const sender = s.offerer.debug();
    expect(sender.confirmed).toBeLessThanOrEqual(at);
    expect(sender.queued).toBeGreaterThan(at);

    const r = await reconnect(s);
    expect(r.ok).toBe(true);
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'verifying', resuming: true });
    await settle();
    expect(payloads(r.oEnd)).toBe(0); // nothing before the new word check
    await verify(s);
    await waitFor(() => s.answerer.getSnapshot().state === 'completed');
    await waitFor(() => s.offerer.getSnapshot().state === 'completed');

    const offsets = frameOffsets(r.oEnd);
    expect(offsets[0]).toBe(at); // not from zero, not from the sender's last ack
    expect(offsets).toEqual(offsets.map((_, i) => at + i * CHUNK));
    expect(manifests(r.oEnd)).toBe(0);
    const done = s.answerer.getSnapshot().downloads[0]!;
    expect(new Uint8Array(await done.blob.arrayBuffer())).toEqual(data);
  });

  it('a lost connection before Accept still fails (nothing to resume)', async () => {
    const s = await setup();
    await verify(s);
    cut(s.oEnd);
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'closed' });
  });

  it('a mismatch on the new connection closes it and keeps the transfer paused', async () => {
    const { s, data } = await pausedAt(20, 60 * CHUNK);
    const r = await reconnect(s);
    s.answerer.mismatch();
    await settle();
    expect(s.answerer.getSnapshot().state).toBe('paused');
    expect(s.offerer.getSnapshot().state).toBe('paused');
    expect(payloads(r.oEnd) + manifests(r.oEnd)).toBe(0);
    await reconnect(s);
    await verify(s);
    await waitFor(() => s.answerer.getSnapshot().state === 'completed');
    const done = s.answerer.getSnapshot().downloads[0]!;
    expect(new Uint8Array(await done.blob.arrayBuffer())).toEqual(data);
  });

  it('a different paused sender cannot resume this transfer; the right one still can', async () => {
    const { s, data } = await pausedAt(10, 40 * CHUNK);
    const { s: other } = await pausedAt(5, 40 * CHUNK);
    const mixed = { offerer: other.offerer, answerer: s.answerer };
    const r = await reconnect(mixed);
    expect(r.ok).toBe(true);
    await verify(mixed);
    await settle();
    expect(s.answerer.getSnapshot().state).toBe('paused');
    expect(other.offerer.getSnapshot().state).toBe('paused');
    expect(payloads(r.oEnd)).toBe(0);
    expect(payloads(r.aEnd)).toBe(0);

    await reconnect(s);
    await verify(s);
    await waitFor(() => s.answerer.getSnapshot().state === 'completed');
    const done = s.answerer.getSnapshot().downloads[0]!;
    expect(new Uint8Array(await done.blob.arrayBuffer())).toEqual(data);
  });

  it('a resume message from an earlier connection is refused (bound to the new words)', async () => {
    const { s } = await pausedAt(10, 40 * CHUNK);
    const r1 = await reconnect(s);
    r1.oEnd.budget = 0; // this connection dies before any chunk arrives
    await verify(s);
    const old = r1.oEnd.sent.find((m) => typeof m === 'string' && m.includes('"resume"'));
    expect(old).toBeDefined();
    cut(r1.oEnd);
    await settle();
    const r2 = await reconnect(s);
    const send = r2.oEnd.send.bind(r2.oEnd);
    r2.oEnd.send = (data) =>
      send(typeof data === 'string' && data.includes('"resume"') ? old! : data);
    await verify(s);
    await settle();
    expect(s.answerer.getSnapshot().state).toBe('paused');
    expect(payloads(r2.oEnd)).toBe(0);
  });

  it.each<[string, (offset: number) => number]>([
    ['beyond what was sent', (o) => o + 200 * CHUNK],
    ['off a chunk boundary', (o) => o + 1],
  ])('the sender refuses a resume offset %s', async (_, change) => {
    const { s } = await pausedAt(10, 300 * CHUNK);
    const r = await reconnect(s);
    const send = r.aEnd.send.bind(r.aEnd);
    r.aEnd.send = (data) => {
      if (typeof data !== 'string' || !data.includes('"resume-from"')) return send(data);
      const msg = JSON.parse(data) as { offset: number };
      send(JSON.stringify({ ...msg, offset: change(msg.offset) }));
    };
    await verify(s);
    await settle();
    expect(s.offerer.getSnapshot().state).toBe('paused');
    expect(payloads(r.oEnd)).toBe(0);
  });
});

describe('session: bounded resume, expiry and cancel (P6-06)', () => {
  it('three failed attempts end the transfer as expired; no further attempt is taken', async () => {
    const { s } = await pausedAt(10, 40 * CHUNK);
    for (let i = 0; i < 3; i++) {
      await reconnect(s);
      s.answerer.mismatch();
      await settle();
    }
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'expired' });
    expect((await reconnect(s)).ok).toBe(false);
  });

  it('a paused transfer expires and its partial data is deleted', async () => {
    const sink = { ...memorySink(), abort: vi.fn(async () => {}) };
    const { s } = await pausedAt(10, 40 * CHUNK, { resumeTtlMs: 500, sink });
    expect(s.answerer.getSnapshot().expiresAt).toBeGreaterThan(Date.now());
    await new Promise((r) => setTimeout(r, 700));
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'expired' });
    expect(s.offerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'expired' });
    expect(sink.abort).toHaveBeenCalled();
    expect((await reconnect(s)).ok).toBe(false);
  });

  it('cancel while paused is final: partial data deleted and no silent resume', async () => {
    const sink = { ...memorySink(), abort: vi.fn(async () => {}) };
    const { s } = await pausedAt(10, 40 * CHUNK, { sink });
    s.answerer.cancel();
    expect(s.answerer.getSnapshot().state).toBe('canceled');
    expect(sink.abort).toHaveBeenCalled();
    const r = await reconnect(s);
    expect(r.ok).toBe(false);
    expect(payloads(r.oEnd)).toBe(0);
  });

  it('cancel during the new word check is final on both sides', async () => {
    const { s } = await pausedAt(10, 40 * CHUNK);
    const r = await reconnect(s);
    s.offerer.cancel();
    await settle();
    expect(s.offerer.getSnapshot().state).toBe('canceled');
    expect(s.answerer.getSnapshot().state).toBe('canceled');
    expect(payloads(r.oEnd)).toBe(0);
  });

  it('a storage failure stops the transfer for good and deletes partial data', async () => {
    const inner = memorySink();
    const sink: Sink = {
      ...inner,
      write: async () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      abort: vi.fn(async () => {}),
    };
    const s = await setup({ files: [new File([random(10 * CHUNK)], 'big')], sink });
    await verify(s);
    await s.answerer.accept();
    await settle();
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'storage' });
    expect(sink.abort).toHaveBeenCalled();
  });
});

describe('session: progress (P6-09)', () => {
  it('reaches listeners a few times per second, not once per chunk', async () => {
    const data = random(400 * CHUNK);
    const s = await setup({ files: [new File([data], 'big')], tuning: { ackEvery: CHUNK } });
    await verify(s);
    let renders = 0;
    s.answerer.subscribe(() => renders++);
    await s.answerer.accept();
    await waitFor(() => s.answerer.getSnapshot().state === 'completed');
    expect(renders).toBeLessThan(40);
    expect(s.answerer.getSnapshot().progress).toMatchObject({
      confirmed: data.length,
      total: data.length,
    });
  });
});
