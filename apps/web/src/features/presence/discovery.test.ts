import { encodeMessage } from '@zipply/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDiscovery, randomDisplayName } from './discovery';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
const ID = 'AAECAwQFBgcICQoLDA0ODw';

const make = () =>
  createDiscovery({
    url: 'wss://signal.example/ws',
    displayName: 'Guest 1234',
    iceServers: [],
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  });

beforeEach(() => (FakeSocket.all = []));

describe('discovery store', () => {
  it('opens nothing until started, and closes on stop', () => {
    const d = make();
    expect(FakeSocket.all).toHaveLength(0);
    d.start();
    expect(FakeSocket.all).toHaveLength(1);
    d.stop();
    expect(FakeSocket.all[0]!.readyState).toBe(3);
  });

  it('reflects presence in its snapshot', () => {
    const d = make();
    d.start();
    const s = FakeSocket.all[0]!;
    s.readyState = 1;
    s.onopen?.();
    s.onmessage?.({
      data: encodeMessage({
        type: 'hello-accepted',
        payload: { peerId: ID, heartbeatSeconds: 20, presenceTtlSeconds: 60 },
      }),
    });
    expect(d.getSnapshot().presence.status).toBe('online');
    expect(d.getSnapshot().link.phase).toBe('idle');
  });

  it('reconnects to a private room and keeps the visibility choice', () => {
    const d = make();
    d.start();
    d.setDiscoverable(true);
    d.setRoom({ capability: 'CAP', hash: 'HASH', expiresAt: Date.now() + 60_000 });
    expect(FakeSocket.all[0]!.readyState).toBe(3);
    const room = FakeSocket.all[1]!;
    expect(room.url).toBe('wss://signal.example/ws/HASH');
    room.onopen?.();
    expect(JSON.parse(room.sent[0]!)).toMatchObject({
      payload: { discoverable: true, room: 'CAP' },
    });
    expect(d.getSnapshot().room?.hash).toBe('HASH');
  });
});

describe('randomDisplayName', () => {
  it('is a short temporary label, not an identifier', () => {
    expect(randomDisplayName()).toMatch(/^Guest \d{4}$/);
  });
});
