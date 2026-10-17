import { encodeMessage, type ServerMessage } from '@zipply/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresence, signalingUrlProblem, type PresenceOptions } from './presence';

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const ID2 = 'EBESExQVFhcYGRobHB0eHw';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.drop(1000);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: ServerMessage | string) {
    this.onmessage?.({ data: typeof m === 'string' ? m : encodeMessage(m) });
  }
  drop(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get messages() {
    return this.sent
      .filter((s) => s !== 'ping')
      .map((s) => {
        const { type, payload } = JSON.parse(s) as { type: string; payload: unknown };
        return { type, payload };
      });
  }
}
const last = () => FakeSocket.all.at(-1)!;

const start = (over: Partial<PresenceOptions> = {}) =>
  createPresence({
    url: 'wss://signal.example/ws',
    displayName: 'Pixl12',
    discoverable: false,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    random: () => 0.5,
    ...over,
  });

function welcome(s: FakeSocket, peers = [{ peerId: ID2, displayName: 'Alex' }]) {
  s.open();
  s.receive({
    type: 'hello-accepted',
    payload: { peerId: ID, heartbeatSeconds: 20, presenceTtlSeconds: 60 },
  });
  s.receive({ type: 'peer-snapshot', payload: { peers } });
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('signalingUrlProblem (P4-07)', () => {
  it.each([
    ['wss://signal.example/ws', null],
    ['ws://localhost:8787/ws', null],
    ['ws://127.0.0.1:8787/ws', null],
    ['ws://[::1]:8787/ws', null],
    ['ws://signal.example/ws', 'insecure'],
    ['ws://localhost.evil.example/ws', 'insecure'],
    ['http://signal.example/ws', 'invalid'],
    ['not a url', 'invalid'],
    [undefined, 'missing'],
    ['', 'missing'],
  ])('%s → %s', (url, problem) => {
    expect(signalingUrlProblem(url)).toBe(problem);
  });
});

describe('presence client', () => {
  it.each([undefined, 'ws://signal.example/ws'])(
    'stays offline and never connects with url %s',
    (url) => {
      const p = start({ url });
      expect(p.getSnapshot()).toMatchObject({ status: 'offline', peers: [] });
      expect(FakeSocket.all).toHaveLength(0);
    },
  );

  it('connects, says hello and shows the snapshot', () => {
    const p = start();
    expect(p.getSnapshot().status).toBe('connecting');
    expect(last().url).toBe('wss://signal.example/ws');
    welcome(last());
    expect(last().messages[0]).toEqual({
      type: 'hello',
      payload: { displayName: 'Pixl12', discoverable: false },
    });
    expect(p.getSnapshot()).toMatchObject({
      status: 'online',
      selfId: ID,
      peers: [{ peerId: ID2, displayName: 'Alex' }],
    });
  });

  it('applies joins and leaves', () => {
    const p = start();
    welcome(last(), []);
    last().receive({
      type: 'peer-joined',
      payload: { peer: { peerId: ID2, displayName: 'Alex' } },
    });
    last().receive({
      type: 'peer-joined',
      payload: { peer: { peerId: ID2, displayName: 'Alex' } },
    });
    expect(p.getSnapshot().peers).toHaveLength(1);
    last().receive({ type: 'peer-left', payload: { peerId: ID2 } });
    expect(p.getSnapshot().peers).toEqual([]);
  });

  it('ignores invalid or forged server messages', () => {
    const p = start();
    welcome(last());
    const before = p.getSnapshot();
    last().receive('{');
    last().receive(JSON.stringify({ version: 1, type: 'peer-verified', payload: { peerId: ID2 } }));
    last().receive(
      JSON.stringify({
        version: 1,
        type: 'peer-joined',
        payload: { peer: { peerId: ID, displayName: 'X', verified: true } },
      }),
    );
    expect(p.getSnapshot()).toBe(before);
  });

  it('sends visibility changes and remembers them for the next hello', () => {
    const p = start();
    welcome(last());
    p.setDiscoverable(true);
    expect(last().messages.at(-1)).toEqual({ type: 'visibility', payload: { discoverable: true } });
    last().drop();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(last().messages[0]).toMatchObject({ payload: { discoverable: true } });
  });

  it('joins a private room by path hash and sends the capability only in hello', () => {
    start({ room: { capability: 'CAP', hash: 'HASH' } });
    expect(last().url).toBe('wss://signal.example/ws/HASH');
    last().open();
    expect(last().messages[0]).toMatchObject({ payload: { room: 'CAP' } });
  });

  it('reconnects with exponential backoff and jitter after losing the connection', () => {
    const p = start({ random: () => 0 }); // jitter factor 0.5
    welcome(last());
    last().drop();
    expect(p.getSnapshot().status).toBe('reconnecting');
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('reports discovery unavailable after repeated failures, keeps retrying, and retries on demand', () => {
    const p = start();
    for (let i = 0; i < 3; i++) {
      last().drop();
      vi.advanceTimersByTime(60_000);
    }
    expect(p.getSnapshot()).toMatchObject({ status: 'offline', unavailable: true });
    const count = FakeSocket.all.length;
    p.retry();
    expect(FakeSocket.all).toHaveLength(count + 1);
    welcome(last());
    expect(p.getSnapshot()).toMatchObject({ status: 'online', unavailable: false });
  });

  it('treats SERVER_BUSY as unavailable', () => {
    const p = start();
    last().open();
    last().receive({ type: 'error', payload: { code: 'SERVER_BUSY' } });
    last().drop(1013);
    expect(p.getSnapshot().unavailable).toBe(true);
  });

  it('stops on an invalid or expired room instead of retrying', () => {
    const p = start({ room: { capability: 'CAP', hash: 'HASH' } });
    last().open();
    last().receive({ type: 'error', payload: { code: 'ROOM_INVALID' } });
    last().drop(1008);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(p.getSnapshot()).toMatchObject({ status: 'offline', roomInvalid: true });
  });

  it('pings every heartbeat and reconnects when pongs stop', () => {
    const p = start();
    welcome(last());
    const first = last();
    vi.advanceTimersByTime(20_000);
    expect(first.sent.filter((s) => s === 'ping')).toHaveLength(1);
    first.receive('pong');
    vi.advanceTimersByTime(40_000); // two more pings, no pong for 40 s
    expect(first.readyState).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(first.readyState).toBe(3);
    expect(p.getSnapshot().status).toBe('reconnecting');
  });

  it('delivers routed messages to listeners', () => {
    const p = start();
    welcome(last());
    const seen: string[] = [];
    p.onMessage((m) => seen.push(m.type));
    last().receive({
      type: 'connection-request',
      payload: { requestId: ID, fromPeerId: ID2, displayName: 'Alex', expiresAt: 1 },
    });
    last().receive({ type: 'error', payload: { code: 'PEER_NOT_FOUND' } });
    expect(seen).toEqual(['connection-request', 'error']);
  });

  it('send() reports false when not connected', () => {
    const p = start();
    expect(p.send({ type: 'cancel', payload: { requestId: ID } })).toBe(false);
    welcome(last());
    expect(p.send({ type: 'cancel', payload: { requestId: ID } })).toBe(true);
  });

  it('close() stops reconnecting', () => {
    const p = start();
    welcome(last());
    p.close();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(p.getSnapshot().status).toBe('offline');
  });

  it('reports NAME_TAKEN and clears it on the next visibility attempt or connection', () => {
    const p = start({ discoverable: true });
    welcome(last());
    last().receive({ type: 'error', payload: { code: 'NAME_TAKEN' } });
    expect(p.getSnapshot().nameTaken).toBe(true);
    p.setDiscoverable(true);
    expect(p.getSnapshot().nameTaken).toBe(false);
    last().receive({ type: 'error', payload: { code: 'NAME_TAKEN' } });
    last().drop();
    expect(p.getSnapshot().nameTaken).toBe(false);
  });
});
