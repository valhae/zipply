import { createPeer as realCreatePeer, type PeerOptions, type Signal } from '../connection/peer';
import { randomBytes, toB64url } from '../connection/sas';
import type { Session } from '../connection/session';
import { decodePairing, encodePairing } from './code';

export interface PairingSnapshot {
  /** creating: gathering candidates; offer: the sender waits for the answer code. */
  phase: 'idle' | 'creating' | 'offer' | 'session' | 'ended';
  role: 'offerer' | 'answerer' | null;
  /** This device's code for the other device; network metadata, kept in memory only. */
  code: string | null;
  session: Session | null;
  error: 'not-zipply' | 'invalid' | 'wrong-kind' | null;
  notice: 'unavailable' | null;
}

type PeerHandle = { start(): Promise<void>; handle(s: Signal): void; close(): void };

export const IDLE_PAIRING: PairingSnapshot = {
  phase: 'idle',
  role: null,
  code: null,
  session: null,
  error: null,
  notice: null,
};

const TERMINAL = ['completed', 'rejected', 'canceled', 'failed'];
const live = (s: Session | null): s is Session => !!s && !TERMINAL.includes(s.getSnapshot().state);

export type Pairing = ReturnType<typeof createPairing>;

/**
 * Manual pairing without signaling (P7-03): the sender's offer and the receiver's answer are
 * carried by the people, as text or QR. Every step is a local action, and the connection then runs
 * the same session as online mode: the word check and the receiver's Accept still gate everything.
 * A paused transfer (P6-05) continues on a new manual connection with a fresh word check.
 */
export function createPairing(o: {
  iceServers: RTCIceServer[];
  createPeer?: (o: PeerOptions) => PeerHandle;
}) {
  const createPeer = o.createPeer ?? realCreatePeer;
  const listeners = new Set<() => void>();
  let snap = IDLE_PAIRING;
  let peer: PeerHandle | null = null;
  let requestId = '';

  const update = (next: Partial<PairingSnapshot>) => {
    snap = { ...snap, ...next };
    listeners.forEach((fn) => fn());
  };
  const paused = (role: 'offerer' | 'answerer') =>
    snap.phase === 'session' &&
    snap.session?.role === role &&
    snap.session.getSnapshot().state === 'paused';
  const ready = (role: 'offerer' | 'answerer') =>
    snap.phase === 'idle' || snap.phase === 'ended' || paused(role);

  /** Ends an attempt; a paused transfer stays on screen so the user can try again. */
  function stop(next: Partial<PairingSnapshot>) {
    const p = peer;
    peer = null;
    p?.close();
    update(
      live(snap.session)
        ? { phase: 'session', code: null, ...next }
        : { ...IDLE_PAIRING, phase: next.notice ? 'ended' : 'idle', ...next },
    );
  }

  function start(role: 'offerer' | 'answerer', files?: File[]) {
    const resume = live(snap.session) ? snap.session : undefined;
    const old = peer;
    peer = null;
    old?.close(); // a paused session ignores this
    requestId = toB64url(randomBytes(16));
    update({ phase: 'creating', role, code: null, error: null, notice: null });
    const p: PeerHandle = createPeer({
      role,
      requestId,
      manual: true,
      iceServers: o.iceServers,
      resume,
      files: role === 'offerer' ? files : undefined,
      send: (signal) => {
        if (peer !== p || signal.type === 'ice-candidate') return;
        void encodePairing(signal).then((code) => {
          if (peer === p) update(signal.type === 'offer' ? { phase: 'offer', code } : { code });
        });
      },
      onSession: (session) => peer === p && update({ phase: 'session', session }),
      onClosed: () => {
        if (peer === p && ['creating', 'offer'].includes(snap.phase))
          stop({ notice: 'unavailable' });
        else if (peer === p && snap.phase === 'session') update({ code: null });
      },
    });
    peer = p;
    return p;
  }

  return {
    getSnapshot: () => snap,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Local action: become the sender and create an offer code; files stay local until after the SAS. */
    send(files: File[]) {
      if (!ready('offerer')) return;
      const p = start('offerer', files);
      void p.start().catch(() => peer === p && stop({ notice: 'unavailable' }));
    },
    /** Local action: the receiver uses the sender's offer code and creates an answer code. */
    async receive(text: string) {
      if (!ready('answerer')) return;
      const decoded = await decodePairing(text, toB64url(randomBytes(16)));
      if (!ready('answerer')) return;
      if (!decoded.ok || decoded.signal.type !== 'offer') {
        return update({ error: decoded.ok ? 'wrong-kind' : decoded.reason });
      }
      const p = start('answerer');
      p.handle({ ...decoded.signal, payload: { ...decoded.signal.payload, requestId } });
    },
    /** Local action: the sender uses the receiver's answer code; accepted once. */
    async connect(text: string) {
      if (snap.phase !== 'offer') return;
      const p = peer;
      const decoded = await decodePairing(text, requestId);
      if (snap.phase !== 'offer' || peer !== p || !p) return;
      if (!decoded.ok || decoded.signal.type !== 'answer') {
        return update({ error: decoded.ok ? 'wrong-kind' : decoded.reason });
      }
      update({ code: null, error: null });
      p.handle(decoded.signal);
    },
    /** Withdraws an attempt, or cancels the transfer on its DataChannel. */
    cancel() {
      if (snap.phase === 'session') return snap.session?.cancel();
      stop({});
    },
    dismiss() {
      snap.session?.dispose();
      const p = peer;
      peer = null;
      p?.close();
      update(IDLE_PAIRING);
    },
  };
}
