// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPeer,
  iceServers,
  routeStats,
  stunHosts,
  type PeerOptions,
  type Signal,
} from './peer';
import { toB64url } from './sas';
import type { Session } from './session';

describe('iceServers', () => {
  it('reads a comma-separated list of STUN URLs', () => {
    expect(iceServers(' stun:stun.cloudflare.com:3478, stun:example.org ')).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:example.org'] },
    ]);
  });

  it.each([undefined, '', ' , '])('uses no server for %j', (value) => {
    expect(iceServers(value)).toEqual([]);
  });

  it('drops anything that is not a STUN URL (no TURN relay, no other schemes)', () => {
    expect(iceServers('turn:relay.example:3478,http://x,stun:ok.example')).toEqual([
      { urls: ['stun:ok.example'] },
    ]);
  });
});

describe('stunHosts', () => {
  it('lists the hostnames the IP disclosure names', () => {
    expect(stunHosts(iceServers('stun:stun.cloudflare.com:3478,stuns:b.example'))).toEqual([
      'stun.cloudflare.com',
      'b.example',
    ]);
    expect(stunHosts([])).toEqual([]);
  });
});

// P6-04 / P6-05: a fake RTCPeerConnection that records descriptions and restarts.
const sdp = (fp: string, ufrag: number) =>
  `v=0\r\na=ice-ufrag:u${ufrag}\r\na=fingerprint:sha-256 ${`${fp}:`.repeat(31)}${fp}\r\n`;

class FakeChannel extends EventTarget {
  readyState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  send() {}
  close() {
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
}

const pcs: FakePc[] = [];
class FakePc extends EventTarget {
  connectionState = 'new';
  iceConnectionState = 'new';
  iceGatheringState = 'new';
  restarted = 0;
  closed = false;
  ufrag = 0;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channel = new FakeChannel();
  sctp = { maxMessageSize: 262_144 };
  constructor(readonly config: RTCConfiguration) {
    super();
    pcs.push(this);
  }
  get currentLocalDescription() {
    return this.localDescription;
  }
  get currentRemoteDescription() {
    return this.remoteDescription;
  }
  createDataChannel() {
    return this.channel;
  }
  restartIce() {
    this.restarted++;
  }
  async setLocalDescription() {
    const type = this.remoteDescription?.type === 'offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: sdp('AA', ++this.ufrag) };
    this.iceGatheringState = 'gathering';
  }
  /** Gathering finished: the description now carries its candidates. */
  async gather() {
    await vi.waitFor(() => expect(this.localDescription).not.toBeNull());
    const d = this.localDescription!;
    this.localDescription = { ...d, sdp: `${d.sdp}a=candidate:1\r\n` };
    const candidate = { toJSON: () => ({ candidate: 'candidate:1', sdpMid: '0' }) };
    this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate }));
    this.iceGatheringState = 'complete';
    this.dispatchEvent(new Event('icegatheringstatechange'));
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d;
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map<string, Record<string, unknown>>([
      ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
      [
        'l',
        { type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '10.0.0.2' },
      ],
      ['r', { type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.9' }],
    ]);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  setState(state: string) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const REQ = 'AAECAwQFBgcICQoLDA0ODw';
const ID = (n: number) => toB64url(new Uint8Array(16).fill(n));
const C32 = toB64url(new Uint8Array(32).fill(7));
const flush = () => vi.advanceTimersByTimeAsync(0);

function open(role: 'offerer' | 'answerer', over: Partial<PeerOptions> = {}) {
  const sent: Signal[] = [];
  const onClosed = vi.fn();
  const onSession = vi.fn();
  const peer = createPeer({
    role,
    requestId: REQ,
    iceServers: [],
    send: (s) => sent.push(s),
    onSession,
    onClosed,
    files: [],
    ...over,
  });
  return { peer, sent, onClosed, onSession, pc: pcs.at(-1)! };
}

/** A connected offerer whose DataChannel is open. */
async function connectedOfferer() {
  const o = open('offerer');
  await o.peer.start();
  const offer = o.sent[0] as Extract<Signal, { type: 'offer' }>;
  o.peer.handle({
    type: 'answer',
    payload: { requestId: REQ, connId: offer.payload.connId, sdp: sdp('BB', 1), nA: ID(9) },
  });
  await flush();
  o.pc.channel.open();
  o.pc.setState('connected');
  return { ...o, offer };
}

/** A connected answerer that answered offer `connId` with commitment C32. */
async function connectedAnswerer() {
  const a = open('answerer');
  a.peer.handle({
    type: 'offer',
    payload: { requestId: REQ, connId: ID(1), sdp: sdp('BB', 1), cO: C32 },
  });
  await flush();
  a.pc.channel.open();
  a.pc.setState('connected');
  const answer = a.sent[0] as Extract<Signal, { type: 'answer' }>;
  return { ...a, answer };
}

describe('ICE restart (P6-04): same connection, so no new word check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', FakePc);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    pcs.length = 0;
  });

  it('the offerer restarts ICE when the connection fails, with the same connId and commitment', async () => {
    const o = await connectedOfferer();
    o.pc.setState('failed');
    await flush();
    expect(o.pc.restarted).toBe(1);
    expect(o.sent.at(-1)).toMatchObject({
      type: 'offer',
      payload: { connId: o.offer.payload.connId, cO: o.offer.payload.cO },
    });
    o.peer.handle({
      type: 'answer',
      payload: { requestId: REQ, connId: o.offer.payload.connId, sdp: sdp('BB', 2), nA: ID(9) },
    });
    await flush();
    o.pc.setState('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(o.pc.closed).toBe(false);
    expect(o.onClosed).not.toHaveBeenCalled();
  });

  it('the offerer restarts after the connection stays disconnected for 5 s', async () => {
    const o = await connectedOfferer();
    o.pc.setState('disconnected');
    await vi.advanceTimersByTimeAsync(4000);
    expect(o.pc.restarted).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(o.pc.restarted).toBe(1);
  });

  it('gives up after 30 s without recovery and closes, so the transfer pauses', async () => {
    const o = await connectedOfferer();
    o.pc.setState('failed');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(o.pc.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(o.pc.closed).toBe(true);
    expect(o.onClosed).toHaveBeenCalled();
  });

  it('the offerer refuses a restart answer with other fingerprints', async () => {
    const o = await connectedOfferer();
    o.pc.setState('failed');
    await flush();
    o.peer.handle({
      type: 'answer',
      payload: { requestId: REQ, connId: o.offer.payload.connId, sdp: sdp('CC', 2), nA: ID(9) },
    });
    await flush();
    expect(o.pc.closed).toBe(true);
  });

  it('the offerer refuses an answer it did not ask for (renegotiation guard)', async () => {
    const o = await connectedOfferer();
    o.peer.handle({
      type: 'answer',
      payload: { requestId: REQ, connId: o.offer.payload.connId, sdp: sdp('BB', 2), nA: ID(9) },
    });
    await flush();
    expect(o.pc.closed).toBe(true);
  });

  it('the answerer applies a restart offer of the same connection and answers with the same nA', async () => {
    const a = await connectedAnswerer();
    a.peer.handle({
      type: 'offer',
      payload: { requestId: REQ, connId: ID(1), sdp: sdp('BB', 2), cO: C32 },
    });
    await flush();
    expect(a.pc.closed).toBe(false);
    expect(a.sent.at(-1)).toMatchObject({
      type: 'answer',
      payload: { connId: ID(1), nA: a.answer.payload.nA },
    });
  });

  it.each([
    ['other fingerprints', { sdp: sdp('CC', 2) }],
    ['another commitment', { cO: toB64url(new Uint8Array(32).fill(8)) }],
    ['another connection id', { connId: ID(2) }],
  ])('the answerer refuses a second offer with %s', async (_, change) => {
    const a = await connectedAnswerer();
    a.peer.handle({
      type: 'offer',
      payload: { requestId: REQ, connId: ID(1), sdp: sdp('BB', 2), cO: C32, ...change },
    });
    await flush();
    expect(a.pc.closed).toBe(true);
  });

  it('never restarts before the DataChannel opened: a failure then just closes', async () => {
    const o = open('offerer');
    await o.peer.start();
    o.pc.setState('failed');
    await flush();
    expect(o.pc.restarted).toBe(0);
    expect(o.pc.closed).toBe(true);
  });
});

describe('resume on a new connection (P6-05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', FakePc);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    pcs.length = 0;
  });

  it('attaches the paused session instead of creating a new one', async () => {
    const paused = { attach: vi.fn(() => true), lost: vi.fn() } as unknown as Session;
    const a = open('answerer', { resume: paused });
    a.peer.handle({
      type: 'offer',
      payload: { requestId: REQ, connId: ID(1), sdp: sdp('BB', 1), cO: C32 },
    });
    await flush();
    expect(paused.attach).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'answerer', channel: a.pc.channel }),
    );
    expect(a.onSession).toHaveBeenCalledWith(paused);
  });

  it('closes when the paused session refuses the new connection', async () => {
    const paused = { attach: vi.fn(() => false), lost: vi.fn() } as unknown as Session;
    const a = open('answerer', { resume: paused });
    a.peer.handle({
      type: 'offer',
      payload: { requestId: REQ, connId: ID(1), sdp: sdp('BB', 1), cO: C32 },
    });
    await flush();
    expect(a.pc.closed).toBe(true);
    expect(a.onSession).not.toHaveBeenCalled();
  });
});

describe('manual pairing (P7-03): one description with every candidate, no signaling path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', FakePc);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    pcs.length = 0;
  });

  it('the offer waits for ICE gathering and carries the candidates; none are sent separately', async () => {
    const o = open('offerer', { manual: true });
    const started = o.peer.start();
    await flush();
    expect(o.sent).toEqual([]);
    await o.pc.gather();
    await started;
    expect(o.sent).toHaveLength(1);
    expect(o.sent[0]).toMatchObject({ type: 'offer' });
    expect((o.sent[0] as Extract<Signal, { type: 'offer' }>).payload.sdp).toContain(
      'a=candidate:1',
    );
  });

  it('sends what was gathered after 10 s instead of waiting forever', async () => {
    const o = open('offerer', { manual: true });
    const started = o.peer.start();
    await vi.waitFor(() => expect(o.pc.localDescription).not.toBeNull());
    await vi.advanceTimersByTimeAsync(9000);
    expect(o.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    await started;
    expect(o.sent).toHaveLength(1);
  });

  it('the answer also waits for gathering', async () => {
    const a = open('answerer', { manual: true });
    a.peer.handle({
      type: 'offer',
      payload: { requestId: REQ, connId: ID(1), sdp: sdp('BB', 1), cO: C32 },
    });
    await flush();
    expect(a.sent).toEqual([]);
    await a.pc.gather();
    await flush();
    expect(a.sent).toEqual([expect.objectContaining({ type: 'answer' })]);
    expect((a.sent[0] as Extract<Signal, { type: 'answer' }>).payload.sdp).toContain(
      'a=candidate:1',
    );
  });

  it('never restarts ICE (there is no path for a new description); the 30 s recovery still closes', async () => {
    const o = open('offerer', { manual: true });
    const started = o.peer.start();
    await o.pc.gather();
    await started;
    const offer = o.sent[0] as Extract<Signal, { type: 'offer' }>;
    o.peer.handle({
      type: 'answer',
      payload: { requestId: REQ, connId: offer.payload.connId, sdp: sdp('BB', 1), nA: ID(9) },
    });
    await flush();
    o.pc.channel.open();
    o.pc.setState('connected');
    o.pc.setState('failed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(o.pc.restarted).toBe(0);
    expect(o.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(o.pc.closed).toBe(true);
  });

  it('gives people 5 minutes to carry the codes across instead of 30 s', async () => {
    const o = open('offerer', { manual: true });
    void o.peer.start();
    await o.pc.gather();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(o.pc.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(o.pc.closed).toBe(true);
    expect(o.onClosed).toHaveBeenCalled();
  });
});

describe('routeStats (debug panel)', () => {
  it('names candidate types and protocol only, never addresses', async () => {
    const stats = await routeStats(new FakePc({}) as unknown as RTCPeerConnection);
    expect(stats).toEqual({ ice: 'new', route: 'host → srflx (udp)' });
    expect(JSON.stringify(stats)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
