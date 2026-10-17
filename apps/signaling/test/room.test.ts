import {
  PING,
  PONG,
  encodeMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@zipply/protocol';
import {
  SELF,
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PENDING, MAX_SOCKETS, type Attachment } from '../src/room';

const ORIGIN = 'http://localhost:5173';
type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const id = () => b64url(rand(16));
const D32 = b64url(new Uint8Array(32));

/** Private-room capability: 16 random bytes + expiry in epoch minutes (u32 BE), and its route hash. */
async function roomCapability(expiresInMinutes = 30) {
  const cap = new Uint8Array(20);
  cap.set(rand(16));
  new DataView(cap.buffer).setUint32(16, Math.floor(Date.now() / 60_000) + expiresInMinutes);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', cap));
  return { room: b64url(cap), path: `/ws/${b64url(hash)}`, name: `room:${b64url(hash)}` };
}

const opened: WebSocket[] = [];
afterEach(() => {
  opened.splice(0).forEach((ws) => ws.readyState === WebSocket.OPEN && ws.close());
});

async function open(path = '/ws') {
  const res = await SELF.fetch(`https://signaling.test${path}`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN },
  });
  const ws = res.webSocket!;
  const inbox: (ServerMessage | string)[] = [];
  let closeCode: number | null = null;
  ws.addEventListener('message', (e) => {
    const r = parseServerMessage(e.data as string);
    inbox.push(r.ok ? r.message : (e.data as string));
  });
  ws.addEventListener('close', (e) => {
    closeCode = e.code;
  });
  ws.accept();
  opened.push(ws);
  const take = <T extends ServerMessage['type']>(type: T) => {
    const i = inbox.findIndex((m) => typeof m !== 'string' && m.type === type);
    return i < 0 ? undefined : (inbox.splice(i, 1)[0] as Of<T>);
  };
  return {
    ws,
    inbox,
    closeCode: () => closeCode,
    send: (m: ClientMessage) => ws.send(encodeMessage(m)),
    next: <T extends ServerMessage['type']>(type: T) =>
      vi.waitFor(() => take(type) ?? Promise.reject(new Error(`no ${type} yet`)), {
        timeout: 2000,
      }),
    async quiet(type: ServerMessage['type']) {
      await new Promise((r) => setTimeout(r, 100));
      expect(take(type)).toBeUndefined();
    },
    closed: () =>
      vi.waitFor(() => (closeCode !== null ? closeCode : Promise.reject(new Error('open'))), {
        timeout: 2000,
      }),
  };
}

async function join(displayName: string, discoverable = true, path = '/ws', room?: string) {
  const c = await open(path);
  c.send({ type: 'hello', payload: { displayName, discoverable, ...(room ? { room } : {}) } });
  const accepted = await c.next('hello-accepted');
  const snapshot = await c.next('peer-snapshot');
  return { ...c, peerId: accepted.payload.peerId, accepted, snapshot };
}

async function requestPair(path = '/ws', room?: string) {
  const a = await join('Alice', true, path, room);
  const b = await join('Bob', true, path, room);
  await a.next('peer-joined');
  const requestId = id();
  a.send({ type: 'connection-request', payload: { requestId, targetPeerId: b.peerId } });
  const incoming = await b.next('connection-request');
  return { a, b, requestId, incoming };
}

const publicRoom = () => env.ROOM.get(env.ROOM.idFromName('public'));
const editAttachments = (stub: DurableObjectStub, edit: (a: Attachment) => void) =>
  runInDurableObject(stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      edit(att);
      ws.serializeAttachment(att);
    }
  });

describe('hello and presence (P4-03)', () => {
  it('assigns a random server peer id and announces only discoverable peers', async () => {
    const hidden = await join('Hidden', false);
    const alice = await join('Alice');
    expect(alice.accepted.payload).toEqual({
      peerId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      heartbeatSeconds: 20,
      presenceTtlSeconds: 60,
    });
    expect(alice.peerId).not.toBe(hidden.peerId);
    const bob = await join('Bob');
    const names = bob.snapshot.payload.peers.map((p) => p.displayName);
    expect(names).toContain('Alice');
    expect(names).not.toContain('Hidden');
    expect(names).not.toContain('Bob');
    expect((await alice.next('peer-joined')).payload.peer).toEqual({
      peerId: bob.peerId,
      displayName: 'Bob',
    });
    await hidden.next('peer-joined'); // invisible peers still see others
  });

  it('snapshots contain only peer id and display name (no IP, location or fingerprint)', async () => {
    await join('Alice');
    const bob = await join('Bob');
    for (const p of bob.snapshot.payload.peers)
      expect(Object.keys(p).sort()).toEqual(['displayName', 'peerId']);
  });

  it('visibility toggles announce join and leave', async () => {
    const watcher = await join('Watcher', false);
    const carol = await join('Carol', false);
    carol.send({ type: 'visibility', payload: { discoverable: true } });
    expect((await watcher.next('peer-joined')).payload.peer.peerId).toBe(carol.peerId);
    carol.send({ type: 'visibility', payload: { discoverable: false } });
    expect((await watcher.next('peer-left')).payload.peerId).toBe(carol.peerId);
  });

  it('a closed socket leaves no ghost', async () => {
    const watcher = await join('Watcher', false);
    const dave = await join('Dave');
    await watcher.next('peer-joined');
    dave.ws.close();
    expect((await watcher.next('peer-left')).payload.peerId).toBe(dave.peerId);
    const late = await join('Late', false);
    expect(late.snapshot.payload.peers.map((p) => p.peerId)).not.toContain(dave.peerId);
  });

  it('answers the heartbeat ping by auto-response', async () => {
    const c = await join('Pinger', false);
    const pong = new Promise((r) =>
      c.ws.addEventListener('message', (e) => e.data === PONG && r(true)),
    );
    c.ws.send(PING);
    expect(await pong).toBe(true);
  });

  it('rebuilds presence from live sockets after the object is evicted (hibernation)', async () => {
    const erin = await join('Erin');
    await evictDurableObject(publicRoom());
    const frank = await join('Frank');
    expect(frank.snapshot.payload.peers.map((p) => p.peerId)).toContain(erin.peerId);
    frank.send({
      type: 'connection-request',
      payload: { requestId: id(), targetPeerId: erin.peerId },
    });
    expect((await erin.next('connection-request')).payload.fromPeerId).toBe(frank.peerId);
  });

  it('the alarm sweep closes peers whose lease lapsed and keeps peers that pinged', async () => {
    const watcher = await join('Watcher', false);
    const stale = await join('Stale');
    await watcher.next('peer-joined');
    await editAttachments(publicRoom(), (a) => (a.seenAt = 0));
    const pong = new Promise((r) =>
      watcher.ws.addEventListener('message', (e) => e.data === PONG && r(true)),
    );
    watcher.ws.send(PING);
    await pong;
    await runDurableObjectAlarm(publicRoom());
    expect(await stale.closed()).toBe(4000);
    expect((await watcher.next('peer-left')).payload.peerId).toBe(stale.peerId);
    expect(watcher.closeCode()).toBeNull();
  });

  it('stores no records in Durable Object storage', async () => {
    await requestPair();
    await runInDurableObject(publicRoom(), async (_i, state) => {
      expect((await state.storage.list()).size).toBe(0);
    });
  });
});

describe('protocol enforcement', () => {
  it.each<[string, (ws: WebSocket) => void]>([
    [
      'a message before hello',
      (ws) => ws.send(encodeMessage({ type: 'visibility', payload: { discoverable: true } })),
    ],
    ['malformed JSON', (ws) => ws.send('{')],
    ['a binary frame (no file data through signaling)', (ws) => ws.send(new Uint8Array(8))],
    [
      'a server-only message type',
      (ws) => ws.send(JSON.stringify({ version: 1, type: 'peer-joined', payload: {} })),
    ],
  ])('closes the socket on %s', async (_, act) => {
    const c = await open();
    act(c.ws);
    expect((await c.next('error')).payload.code).toMatch(/INVALID_MESSAGE|UNSUPPORTED_VERSION/);
    expect(await c.closed()).toBe(1008);
  });

  it('rejects a second hello', async () => {
    const c = await join('Twice', false);
    c.send({ type: 'hello', payload: { displayName: 'Again', discoverable: true } });
    expect(await c.closed()).toBe(1008);
  });
});

describe('connection requests and signal routing (P4-04)', () => {
  it('forwards the request with sender label and expiry only', async () => {
    const { a, incoming, requestId } = await requestPair();
    expect(incoming.payload).toEqual({
      requestId,
      fromPeerId: a.peerId,
      displayName: 'Alice',
      expiresAt: expect.any(Number),
    });
    expect(incoming.payload.expiresAt - Date.now()).toBeGreaterThan(50_000);
  });

  it('routes offer, answer and ICE only after acceptance, and only between the pair', async () => {
    const { a, b, requestId } = await requestPair();
    const connId = id();
    const offer = { type: 'offer', payload: { requestId, connId, sdp: 'v=0', cO: D32 } } as const;
    a.send(offer);
    expect((await a.next('error')).payload.code).toBe('REQUEST_EXPIRED');
    await b.quiet('offer');

    b.send({ type: 'connection-response', payload: { requestId, accept: true } });
    expect((await a.next('connection-response')).payload).toEqual({ requestId, accept: true });
    a.send(offer);
    expect((await b.next('offer')).payload).toEqual(offer.payload);
    b.send({ type: 'answer', payload: { requestId, connId, sdp: 'v=0', nA: id() } });
    await a.next('answer');
    const ice = { requestId, connId, candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } };
    b.send({ type: 'ice-candidate', payload: ice });
    expect((await a.next('ice-candidate')).payload).toEqual(ice);
  });

  it('enforces roles: the requester cannot answer and the target cannot offer', async () => {
    const { a, b, requestId } = await requestPair();
    b.send({ type: 'connection-response', payload: { requestId, accept: true } });
    await a.next('connection-response');
    a.send({ type: 'answer', payload: { requestId, connId: id(), sdp: 'v=0', nA: id() } });
    expect((await a.next('error')).payload.code).toBe('REQUEST_EXPIRED');
    b.send({ type: 'offer', payload: { requestId, connId: id(), sdp: 'v=0', cO: D32 } });
    expect((await b.next('error')).payload.code).toBe('REQUEST_EXPIRED');
  });

  it('a third peer cannot use another pair’s request id', async () => {
    const { a, b, requestId } = await requestPair();
    b.send({ type: 'connection-response', payload: { requestId, accept: true } });
    await a.next('connection-response');
    const mallory = await join('Mallory', false);
    mallory.send({ type: 'offer', payload: { requestId, connId: id(), sdp: 'v=0', cO: D32 } });
    expect((await mallory.next('error')).payload.code).toBe('REQUEST_EXPIRED');
    mallory.send({ type: 'cancel', payload: { requestId } });
    await mallory.next('error');
    await b.quiet('offer');
    await a.quiet('cancel');
  });

  it('rejection and cancel are final; request ids cannot be revived', async () => {
    const { a, b, requestId } = await requestPair();
    b.send({ type: 'connection-response', payload: { requestId, accept: false } });
    expect((await a.next('connection-response')).payload.accept).toBe(false);
    b.send({ type: 'connection-response', payload: { requestId, accept: true } });
    expect((await b.next('error')).payload.code).toBe('REQUEST_EXPIRED');

    const second = id();
    a.send({ type: 'connection-request', payload: { requestId: second, targetPeerId: b.peerId } });
    await b.next('connection-request');
    a.send({ type: 'cancel', payload: { requestId: second } });
    expect((await b.next('cancel')).payload.requestId).toBe(second);
    b.send({ type: 'connection-response', payload: { requestId: second, accept: true } });
    expect((await b.next('error')).payload.code).toBe('REQUEST_EXPIRED');
  });

  it('expired requests are refused', async () => {
    const { b, requestId } = await requestPair();
    await editAttachments(publicRoom(), (att) => att.pending.forEach((p) => (p.expiresAt = 0)));
    b.send({ type: 'connection-response', payload: { requestId, accept: true } });
    expect((await b.next('error')).payload.code).toBe('REQUEST_EXPIRED');
  });

  it('a disconnect cancels the pair’s pending request for the other side', async () => {
    const { a, b, requestId } = await requestPair();
    a.ws.close();
    expect((await b.next('cancel')).payload.requestId).toBe(requestId);
  });

  it('requests to unknown, hidden or own peers are refused without revealing who exists', async () => {
    const a = await join('Alice');
    const hidden = await join('Hidden', false);
    for (const targetPeerId of [id(), hidden.peerId, a.peerId]) {
      a.send({ type: 'connection-request', payload: { requestId: id(), targetPeerId } });
      expect((await a.next('error')).payload.code).toBe('PEER_NOT_FOUND');
    }
    await hidden.quiet('connection-request');
  });
});

describe('limits (P4-05)', () => {
  it('throttles a flooding socket without affecting others', async () => {
    const flooder = await join('Flooder', false);
    const calm = await join('Calm', false);
    for (let i = 0; i < 200; i++)
      flooder.send({ type: 'visibility', payload: { discoverable: false } });
    expect((await flooder.next('error')).payload.code).toBe('RATE_LIMITED');
    const target = await join('Target');
    calm.send({
      type: 'connection-request',
      payload: { requestId: id(), targetPeerId: target.peerId },
    });
    await target.next('connection-request');
  });

  it(`caps pending requests per socket at ${MAX_PENDING}`, async () => {
    const a = await join('Alice');
    const b = await join('Bob');
    for (let i = 0; i < MAX_PENDING; i++) {
      a.send({ type: 'connection-request', payload: { requestId: id(), targetPeerId: b.peerId } });
      await b.next('connection-request');
    }
    a.send({ type: 'connection-request', payload: { requestId: id(), targetPeerId: b.peerId } });
    expect((await a.next('error')).payload.code).toBe('RATE_LIMITED');
  });

  it(`turns away socket ${MAX_SOCKETS + 1} with SERVER_BUSY`, async () => {
    const { path } = await roomCapability();
    for (let i = 0; i < MAX_SOCKETS; i++) await open(path);
    const extra = await open(path);
    expect((await extra.next('error')).payload.code).toBe('SERVER_BUSY');
    expect(await extra.closed()).toBe(1013);
  });
});

describe('private rooms (P4-06)', () => {
  it('admits holders of the capability and keeps rooms separate', async () => {
    const cap = await roomCapability();
    const outsider = await join('Outsider');
    const a = await join('Alice', true, cap.path, cap.room);
    const b = await join('Bob', true, cap.path, cap.room);
    expect(b.snapshot.payload.peers.map((p) => p.peerId)).toEqual([a.peerId]);
    await outsider.quiet('peer-joined');
  });

  it.each([
    [
      'a wrong capability',
      async () => ({ ...(await roomCapability()), room: (await roomCapability()).room }),
    ],
    ['an expired capability', () => roomCapability(-1)],
    ['no capability', async () => ({ ...(await roomCapability()), room: undefined })],
  ])('rejects %s', async (_, make) => {
    const cap = await make();
    const c = await open(cap.path);
    c.send({
      type: 'hello',
      payload: { displayName: 'X', discoverable: true, ...(cap.room ? { room: cap.room } : {}) },
    });
    expect((await c.next('error')).payload.code).toBe('ROOM_INVALID');
    expect(await c.closed()).toBe(1008);
  });

  it('rejects a capability sent to the public lobby', async () => {
    const { room } = await roomCapability();
    const c = await open('/ws');
    c.send({ type: 'hello', payload: { displayName: 'X', discoverable: true, room } });
    expect((await c.next('error')).payload.code).toBe('ROOM_INVALID');
  });
});
