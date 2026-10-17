import type { ClientMessage, ServerMessage } from '@zipply/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLink } from './link';
import type { PeerOptions } from './peer';
import type { Session } from './session';

const PEER = 'EBESExQVFhcYGRobHB0eHw';
const OTHER_ID = 'AAECAwQFBgcICQoLDA0ODw';

function setup(sendOk = true) {
  const sent: ClientMessage[] = [];
  const handlers = new Set<(m: ServerMessage) => void>();
  const presence = {
    send: (m: ClientMessage) => (sent.push(m), sendOk),
    onMessage: (fn: (m: ServerMessage) => void) => (
      handlers.add(fn),
      () => void handlers.delete(fn)
    ),
  };
  const peers: {
    opts: PeerOptions;
    start: ReturnType<typeof vi.fn>;
    handle: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const createPeer = (opts: PeerOptions) => {
    const p = {
      opts,
      start: vi.fn(async () => {}),
      handle: vi.fn(),
      close: vi.fn(() => opts.onClosed?.()),
    };
    peers.push(p);
    return p;
  };
  const link = createLink({ presence, iceServers: [], createPeer });
  const emit = (m: ServerMessage) => handlers.forEach((fn) => fn(m));
  return { link, sent, peers, emit };
}
const fakeSession = () =>
  ({ cancel: vi.fn(), dispose: vi.fn(), lost: vi.fn() }) as unknown as Session;
const files = [new File(['x'], 'a.txt')];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('outgoing request', () => {
  it('sends a connection request with a fresh random id and no file metadata', () => {
    const { link, sent } = setup();
    link.request(PEER, 'Alex', files);
    expect(sent).toEqual([
      {
        type: 'connection-request',
        payload: { requestId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), targetPeerId: PEER },
      },
    ]);
    expect(link.getSnapshot()).toMatchObject({
      phase: 'requesting',
      peerId: PEER,
      peerName: 'Alex',
    });
  });

  it('starts the offerer only after the target accepts, then shows the session', () => {
    const { link, sent, peers, emit } = setup();
    link.request(PEER, 'Alex', files);
    const { requestId } = sent[0]!.payload as { requestId: string };
    expect(peers).toHaveLength(0);
    emit({ type: 'connection-response', payload: { requestId, accept: true } });
    expect(peers[0]!.opts).toMatchObject({ role: 'offerer', requestId, files });
    expect(peers[0]!.start).toHaveBeenCalledOnce();
    const session = fakeSession();
    peers[0]!.opts.onSession(session);
    expect(link.getSnapshot()).toMatchObject({ phase: 'session', role: 'offerer', session });
  });

  it('a declined request ends without a peer connection', () => {
    const { link, sent, peers, emit } = setup();
    link.request(PEER, 'Alex', files);
    const { requestId } = sent[0]!.payload as { requestId: string };
    emit({ type: 'connection-response', payload: { requestId, accept: false } });
    expect(link.getSnapshot()).toMatchObject({ phase: 'ended', notice: 'declined' });
    expect(peers).toHaveLength(0);
  });

  it('ignores responses for other requests and server errors end the request', () => {
    const { link, peers, emit } = setup();
    link.request(PEER, 'Alex', files);
    emit({ type: 'connection-response', payload: { requestId: OTHER_ID, accept: true } });
    expect(peers).toHaveLength(0);
    emit({ type: 'error', payload: { code: 'PEER_NOT_FOUND' } });
    expect(link.getSnapshot()).toMatchObject({ phase: 'ended', notice: 'unavailable' });
  });

  it('reports when signaling is not connected', () => {
    const { link } = setup(false);
    link.request(PEER, 'Alex', files);
    expect(link.getSnapshot()).toMatchObject({ phase: 'ended', notice: 'unavailable' });
  });

  it('cancel() withdraws a pending request', () => {
    const { link, sent } = setup();
    link.request(PEER, 'Alex', files);
    const { requestId } = sent[0]!.payload as { requestId: string };
    link.cancel();
    expect(sent.at(-1)).toEqual({ type: 'cancel', payload: { requestId } });
    expect(link.getSnapshot().phase).toBe('idle');
  });
});

describe('incoming request', () => {
  const incoming = (expiresAt = Date.now() + 60_000): ServerMessage => ({
    type: 'connection-request',
    payload: { requestId: OTHER_ID, fromPeerId: PEER, displayName: 'Alex', expiresAt },
  });

  it('waits for an explicit Accept before answering anything', () => {
    const { link, sent, peers, emit } = setup();
    emit(incoming());
    expect(link.getSnapshot()).toMatchObject({ phase: 'incoming', peerId: PEER, peerName: 'Alex' });
    expect(sent).toEqual([]);
    link.accept();
    expect(sent).toEqual([
      { type: 'connection-response', payload: { requestId: OTHER_ID, accept: true } },
    ]);
    expect(peers[0]!.opts).toMatchObject({ role: 'answerer', requestId: OTHER_ID });
    expect(peers[0]!.opts.files).toBeUndefined();
  });

  it('decline() refuses and returns to idle', () => {
    const { link, sent, peers, emit } = setup();
    emit(incoming());
    link.decline();
    expect(sent).toEqual([
      { type: 'connection-response', payload: { requestId: OTHER_ID, accept: false } },
    ]);
    expect(peers).toHaveLength(0);
    expect(link.getSnapshot().phase).toBe('idle');
  });

  it('auto-declines a request that arrives while busy', () => {
    const { link, sent, emit } = setup();
    link.request(PEER, 'Alex', files);
    emit({
      ...incoming(),
      payload: { ...(incoming().payload as object), requestId: OTHER_ID },
    } as ServerMessage);
    expect(sent.at(-1)).toEqual({
      type: 'connection-response',
      payload: { requestId: OTHER_ID, accept: false },
    });
    expect(link.getSnapshot().phase).toBe('requesting');
  });

  it('expires when the deadline passes', () => {
    const { link, emit } = setup();
    emit(incoming(Date.now() + 5_000));
    vi.advanceTimersByTime(5_001);
    expect(link.getSnapshot()).toMatchObject({ phase: 'ended', notice: 'expired' });
  });
});

describe('signals and advisory cancel (SD-04)', () => {
  function connected() {
    const s = setup();
    s.link.request(PEER, 'Alex', files);
    const { requestId } = s.sent[0]!.payload as { requestId: string };
    s.emit({ type: 'connection-response', payload: { requestId, accept: true } });
    return { ...s, requestId, peer: s.peers[0]! };
  }

  it('routes signals of this request to the peer, and sends the peer’s signals', () => {
    const { emit, peer, requestId, sent } = connected();
    const answer: ServerMessage = {
      type: 'answer',
      payload: { requestId, connId: OTHER_ID, sdp: 'v=0', nA: OTHER_ID },
    };
    emit(answer);
    emit({ ...answer, payload: { ...answer.payload, requestId: OTHER_ID } } as ServerMessage);
    expect(peer.handle).toHaveBeenCalledExactlyOnceWith(answer);
    peer.opts.send({
      type: 'ice-candidate',
      payload: {
        requestId,
        connId: OTHER_ID,
        candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 },
      },
    });
    expect(sent.at(-1)?.type).toBe('ice-candidate');
  });

  it('a signaling cancel stops the connection', () => {
    const { link, emit, peer, requestId } = connected();
    emit({ type: 'cancel', payload: { requestId } });
    expect(peer.close).toHaveBeenCalled();
    expect(link.getSnapshot()).toMatchObject({ phase: 'ended', notice: 'canceled' });
  });

  it('a signaling message can never start or accept a connection', () => {
    const { link, peers, emit } = setup();
    emit({ type: 'connection-response', payload: { requestId: OTHER_ID, accept: true } });
    emit({ type: 'cancel', payload: { requestId: OTHER_ID } });
    emit({
      type: 'offer',
      payload: { requestId: OTHER_ID, connId: OTHER_ID, sdp: 'v=0', cO: 'A'.repeat(43) },
    });
    expect(peers).toHaveLength(0);
    expect(link.getSnapshot().phase).toBe('idle');
  });

  it('a connection that closes before a session ends the attempt', () => {
    const { link, peer } = connected();
    peer.opts.onClosed?.();
    expect(link.getSnapshot()).toMatchObject({ phase: 'ended', notice: 'unavailable' });
  });

  it('dismiss() disposes the session and returns to idle', () => {
    const { link, peer } = connected();
    const session = fakeSession();
    peer.opts.onSession(session);
    link.dismiss();
    expect(session.dispose).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
    expect(link.getSnapshot().phase).toBe('idle');
  });
});
