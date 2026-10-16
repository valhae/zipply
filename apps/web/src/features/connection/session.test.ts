// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { commit, randomBytes } from './sas';
import { createSession, type Session, type SessionOptions } from './session';

type Listener = (e: { data?: unknown }) => void;
interface FakeEnd {
  readyState: string;
  binaryType: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  sent: (string | ArrayBuffer)[];
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

const sessions: Session[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

async function setup(
  over: { files?: File[]; cO?: Uint8Array; answerSdp?: string; cap?: number } = {},
) {
  const [oEnd, aEnd] = channelPair();
  const connId = randomBytes(16);
  const nO = randomBytes(16);
  const nA = randomBytes(16);
  const cO = await commit(connId, nO);
  const common = { maxMessageSize: () => 1024 + 70, onClose: () => {} };
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
    receiveCap: over.cap,
  });
  sessions.push(offerer, answerer);
  await settle();
  return { offerer, answerer, oEnd, aEnd };
}

const verify = async (s: Awaited<ReturnType<typeof setup>>) => {
  s.offerer.confirm();
  s.answerer.confirm();
  await settle();
};

describe('session: happy path', () => {
  it('shows the same phrase on both sides and nothing else before confirmation', async () => {
    const s = await setup();
    const o = s.offerer.getSnapshot();
    const a = s.answerer.getSnapshot();
    expect(o.phrase).toHaveLength(6);
    expect(a.phrase).toEqual(o.phrase);
    expect([o.state, a.state]).toEqual(['verifying', 'verifying']);
    expect(a.manifest).toBeNull();
    expect(manifests(s.oEnd) + payloads(s.oEnd)).toBe(0);
  });

  it('transfers several files byte-exact after both confirmations and acceptance', async () => {
    const data = [random(0), random(1), random(1024), random(1025), random(5000)];
    const names = ['empty', 'one', 'chunk', 'chunk+1', 'many'];
    const s = await setup({ files: data.map((d, i) => new File([d], names[i]!)) });
    s.offerer.confirm();
    await settle();
    expect(manifests(s.oEnd)).toBe(0); // only one side confirmed
    s.answerer.confirm();
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

  it('a terminal state purges the phrase (SD-02 step 8)', async () => {
    const s = await setup();
    expect(s.answerer.getSnapshot().phrase).not.toBeNull();
    s.answerer.mismatch();
    await settle();
    expect(s.answerer.getSnapshot().phrase).toBeNull();
    expect(s.offerer.getSnapshot().phrase).toBeNull();
  });

  it('substituted fingerprints (MITM) → different phrases, and confirming anyway fails', async () => {
    const s = await setup({ answerSdp: fp('CC') });
    expect(s.answerer.getSnapshot().phrase).not.toEqual(s.offerer.getSnapshot().phrase);
    await verify(s);
    expect(s.offerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'mismatch' });
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'failed', reason: 'mismatch' });
    expect(manifests(s.oEnd) + payloads(s.oEnd)).toBe(0);
  });

  it('commitment mismatch → answerer fails before showing a phrase', async () => {
    const s = await setup({ cO: randomBytes(32) });
    expect(s.answerer.getSnapshot()).toMatchObject({
      state: 'failed',
      reason: 'commitment',
      phrase: null,
    });
  });

  it('over-cap manifest is rejected automatically before any payload', async () => {
    const s = await setup({ files: [new File([random(2000)], 'big')], cap: 1000 });
    await verify(s);
    expect(s.answerer.getSnapshot()).toMatchObject({ state: 'rejected', tooLarge: true });
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
