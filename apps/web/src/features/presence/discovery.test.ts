import { encodeMessage, isValidDisplayName, type ServerMessage } from '@zipply/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDiscovery,
  forgetName,
  randomPixelName,
  rememberName,
  storedName,
} from './discovery';

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
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: ServerMessage) {
    this.onmessage?.({ data: encodeMessage(m) });
  }
  get hello() {
    return JSON.parse(this.sent[0]!).payload as { displayName: string; discoverable: boolean };
  }
}
const ID = 'AAECAwQFBgcICQoLDA0ODw';
const last = () => FakeSocket.all.at(-1)!;
const welcome = (s: FakeSocket) => {
  s.open();
  s.receive({
    type: 'hello-accepted',
    payload: { peerId: ID, heartbeatSeconds: 20, presenceTtlSeconds: 60 },
  });
};

const make = (customName: string | null = null) =>
  createDiscovery({
    url: 'wss://signal.example/ws',
    customName,
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

  it('reflects presence, name and visibility in its snapshot', () => {
    const d = make('Mar');
    d.start();
    welcome(last());
    expect(d.getSnapshot()).toMatchObject({
      presence: { status: 'online' },
      link: { phase: 'idle' },
      name: 'Mar',
      customName: true,
      discoverable: false,
    });
  });

  it('reconnects to a private room and keeps the visibility choice', () => {
    const d = make();
    d.start();
    d.setDiscoverable(true);
    d.setRoom({ capability: 'CAP', hash: 'HASH', expiresAt: Date.now() + 60_000 });
    expect(FakeSocket.all[0]!.readyState).toBe(3);
    expect(last().url).toBe('wss://signal.example/ws/HASH');
    last().open();
    expect(JSON.parse(last().sent[0]!)).toMatchObject({
      payload: { discoverable: true, room: 'CAP' },
    });
    expect(d.getSnapshot().room?.hash).toBe('HASH');
  });
});

describe('names', () => {
  it('starts with a pixel-style auto name when no custom name is kept', () => {
    const d = make();
    d.start();
    last().open();
    expect(d.getSnapshot()).toMatchObject({ customName: false });
    expect(last().hello.displayName).toBe(d.getSnapshot().name);
  });

  it('renaming reconnects so the new name is sent in a fresh hello', () => {
    const d = make();
    d.start();
    d.setDisplayName('Mar');
    expect(FakeSocket.all[0]!.readyState).toBe(3);
    last().open();
    expect(last().hello.displayName).toBe('Mar');
    expect(d.getSnapshot()).toMatchObject({ name: 'Mar', customName: true });
  });

  it('picks another auto name and stays visible when the auto name is taken', () => {
    const d = make();
    d.start();
    d.setDiscoverable(true);
    welcome(last());
    const first = d.getSnapshot().name;
    last().receive({ type: 'error', payload: { code: 'NAME_TAKEN' } });
    expect(d.getSnapshot().name).not.toBe(first);
    last().open();
    expect(last().hello).toEqual({ displayName: d.getSnapshot().name, discoverable: true });
  });

  it('keeps a taken custom name, goes hidden and says so', () => {
    const d = make('Mar');
    d.start();
    d.setDiscoverable(true);
    welcome(last());
    const sockets = FakeSocket.all.length;
    last().receive({ type: 'error', payload: { code: 'NAME_TAKEN' } });
    expect(FakeSocket.all).toHaveLength(sockets); // no reconnect
    expect(d.getSnapshot()).toMatchObject({
      name: 'Mar',
      discoverable: false,
      presence: { nameTaken: true },
    });
  });

  it('randomName() switches back to a fresh auto name', () => {
    const d = make('Mar');
    d.start();
    d.randomName();
    expect(d.getSnapshot()).toMatchObject({ customName: false });
    expect(d.getSnapshot().name).not.toBe('Mar');
  });
});

describe('randomPixelName', () => {
  it('is one valid word of two different pixel words, no digits, and varied', () => {
    const names = Array.from({ length: 300 }, randomPixelName);
    for (const n of names) {
      const [, a, b] = /^([A-Z][a-z]+)([A-Z][a-z]+)$/.exec(n)!;
      expect(a).not.toBe(b);
      expect(isValidDisplayName(n)).toBe(true);
    }
    expect(new Set(names).size).toBeGreaterThan(200);
  });
});

describe('remembered custom name (this device only)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips and can be forgotten', () => {
    rememberName('Mar');
    expect(storedName()).toBe('Mar');
    forgetName();
    expect(storedName()).toBeNull();
  });

  it.each([
    ['too long', 'x'.repeat(33)],
    ['two words', 'Mar laptop'],
    ['bidi override', 'a‮b'],
  ])('ignores a stored %s', (_, bad) => {
    localStorage.setItem('zipply-name', bad);
    expect(storedName()).toBeNull();
  });

  it('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberName('Mar')).not.toThrow();
    expect(() => forgetName()).not.toThrow();
    expect(storedName()).toBeNull();
  });
});
