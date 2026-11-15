// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { PeerOptions, Signal } from '../connection/peer';
import { toB64url } from '../connection/sas';
import type { Session } from '../connection/session';
import { decodePairing, encodePairing } from './code';
import { createPairing } from './pairing';

const CONN = toB64url(new Uint8Array(16).fill(1));
const CO = toB64url(new Uint8Array(32).fill(7));
const NA = toB64url(new Uint8Array(16).fill(9));
const SDP = 'v=0\r\na=candidate:1 1 udp 1 x.local 9 typ host\r\n';
const REQ = toB64url(new Uint8Array(16).fill(4));
const offerCode = () =>
  encodePairing({ type: 'offer', payload: { requestId: REQ, connId: CONN, sdp: SDP, cO: CO } });
const answerCode = () =>
  encodePairing({ type: 'answer', payload: { requestId: REQ, connId: CONN, sdp: SDP, nA: NA } });

const fakeSession = (state = 'connecting', role = 'offerer') =>
  ({
    role,
    getSnapshot: () => ({ state }),
    cancel: vi.fn(),
    dispose: vi.fn(),
  }) as unknown as Session;

/** A fake peer: the offerer "gathers" and sends its offer on start; handle() mirrors peer.ts. */
function setup() {
  const peers: {
    opts: PeerOptions;
    handle: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const createPeer = (opts: PeerOptions) => {
    const session = fakeSession('connecting', opts.role);
    const p = {
      opts,
      start: vi.fn(async () =>
        opts.send({
          type: 'offer',
          payload: { requestId: opts.requestId, connId: CONN, sdp: SDP, cO: CO },
        }),
      ),
      handle: vi.fn((s: Signal) => {
        opts.onSession(opts.resume ?? session);
        if (s.type === 'offer') {
          opts.send({
            type: 'answer',
            payload: { requestId: opts.requestId, connId: CONN, sdp: SDP, nA: NA },
          });
        }
      }),
      close: vi.fn(() => opts.onClosed?.()),
    };
    peers.push(p);
    return p;
  };
  const pairing = createPairing({ iceServers: [], createPeer });
  const settle = () => vi.waitFor(() => expect(pairing.getSnapshot().phase).not.toBe('creating'));
  return { pairing, peers, settle };
}
const files = [new File(['x'], 'a.txt')];

describe('manual pairing store (P7-03)', () => {
  it('starts nothing until a local action', () => {
    const { pairing, peers } = setup();
    expect(peers).toEqual([]);
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'idle', code: null, session: null });
  });

  it('send: a manual offerer with the chosen files shows its offer as a code', async () => {
    const { pairing, peers, settle } = setup();
    pairing.send(files);
    await settle();
    expect(peers[0]!.opts).toMatchObject({ role: 'offerer', manual: true, files });
    const snap = pairing.getSnapshot();
    expect(snap).toMatchObject({ phase: 'offer', role: 'offerer' });
    expect(await decodePairing(snap.code!, REQ)).toMatchObject({
      ok: true,
      signal: { type: 'offer', payload: { cO: CO } },
    });
  });

  it('receive: an offer code makes a manual answerer, which shows its answer code', async () => {
    const { pairing, peers } = setup();
    await pairing.receive(await offerCode());
    await vi.waitFor(() => expect(pairing.getSnapshot().code).not.toBeNull());
    const p = peers[0]!;
    expect(p.opts).toMatchObject({ role: 'answerer', manual: true });
    expect(p.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'offer',
        payload: expect.objectContaining({ requestId: p.opts.requestId }),
      }),
    );
    const snap = pairing.getSnapshot();
    expect(snap).toMatchObject({ phase: 'session', role: 'answerer' });
    expect(await decodePairing(snap.code!, REQ)).toMatchObject({
      ok: true,
      signal: { type: 'answer' },
    });
  });

  it.each([
    ['an answer code', answerCode, 'wrong-kind'],
    ['other text', async () => 'hello', 'not-zipply'],
    ['a broken code', async () => 'zipply1.AAAA', 'invalid'],
  ])('receive refuses %s and starts nothing', async (_, make, error) => {
    const { pairing, peers } = setup();
    await pairing.receive(await make());
    expect(peers).toEqual([]);
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'idle', error });
  });

  it('connect: the answer code is handed to the offerer, once', async () => {
    const { pairing, peers, settle } = setup();
    pairing.send(files);
    await settle();
    const code = await answerCode();
    await pairing.connect(code);
    expect(peers[0]!.handle).toHaveBeenCalledTimes(1);
    expect(peers[0]!.handle).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer' }));
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'session', code: null });
    await pairing.connect(code);
    expect(peers[0]!.handle).toHaveBeenCalledTimes(1);
  });

  it('connect refuses an offer code and keeps waiting for the answer', async () => {
    const { pairing, peers, settle } = setup();
    pairing.send(files);
    await settle();
    await pairing.connect(await offerCode());
    expect(peers[0]!.handle).not.toHaveBeenCalled();
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'offer', error: 'wrong-kind' });
  });

  it('a connection that closes before a session explains itself and forgets the code', async () => {
    const { pairing, peers, settle } = setup();
    pairing.send(files);
    await settle();
    peers[0]!.opts.onClosed!();
    expect(pairing.getSnapshot()).toMatchObject({
      phase: 'ended',
      notice: 'unavailable',
      code: null,
    });
  });

  it('cancel stops a pending attempt; in a session it cancels the transfer', async () => {
    const { pairing, peers, settle } = setup();
    pairing.send(files);
    await settle();
    pairing.cancel();
    expect(peers[0]!.close).toHaveBeenCalled();
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'idle', code: null });

    await pairing.receive(await offerCode());
    await settle();
    const session = pairing.getSnapshot().session!;
    pairing.cancel();
    expect(session.cancel).toHaveBeenCalled();
  });

  it('dismiss releases the session and returns to idle', async () => {
    const { pairing, settle } = setup();
    await pairing.receive(await offerCode());
    await settle();
    const session = pairing.getSnapshot().session!;
    pairing.dismiss();
    expect(session.dispose).toHaveBeenCalled();
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'idle', session: null, code: null });
  });

  it('a paused transfer continues on a new manual connection (fresh word check, P6-05)', async () => {
    const { pairing, peers, settle } = setup();
    pairing.send(files);
    await settle();
    await pairing.connect(await answerCode());
    const session = pairing.getSnapshot().session as Session & {
      getSnapshot: () => { state: string };
    };
    session.getSnapshot = () => ({ state: 'paused' }) as never;
    pairing.send([]);
    await settle();
    expect(peers[1]!.opts).toMatchObject({ role: 'offerer', manual: true, resume: session });
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'offer', session });
    // Withdrawing that attempt leaves the paused transfer on screen.
    pairing.cancel();
    expect(session.cancel).not.toHaveBeenCalled();
    expect(pairing.getSnapshot()).toMatchObject({ phase: 'session', session });
  });

  it('a paused receiver resumes from a new offer code; one that is not paused cannot start a second', async () => {
    const { pairing, peers, settle } = setup();
    await pairing.receive(await offerCode());
    await settle();
    await pairing.receive(await offerCode());
    expect(peers).toHaveLength(1);
    const session = pairing.getSnapshot().session as Session & {
      getSnapshot: () => { state: string };
    };
    session.getSnapshot = () => ({ state: 'paused' }) as never;
    await pairing.receive(await offerCode());
    await settle();
    expect(peers[1]!.opts).toMatchObject({ role: 'answerer', resume: session });
  });
});
