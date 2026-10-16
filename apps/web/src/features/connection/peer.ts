import { b64, exact, text, uint, type Check } from '../transfer/frames';
import { commit, fromB64url, randomBytes, toB64url } from './sas';
import { createSession, type Session } from './session';

// Signaling payloads for one connection (SECURITY_DECISIONS SD-02 steps 1–2). SDP and candidates are
// sensitive network metadata: never log, display or persist them.
export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}
export type Signal =
  | { kind: 'offer'; connId: string; sdp: string; cO: string }
  | { kind: 'answer'; connId: string; sdp: string; nA: string }
  | { kind: 'ice'; connId: string; candidate: IceCandidate };

const MAX_SDP = 16 * 1024;
const MAX_CANDIDATE = 1024;
const CONNECT_TIMEOUT_MS = 30_000;

const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const candidateShape = {
  candidate: text(0, MAX_CANDIDATE),
  sdpMid: nullable(text(0, 64)),
  sdpMLineIndex: nullable((v) => uint(v) && (v as number) < 1024),
};
const candidate: Check = (v) =>
  exact(candidateShape)(v) ||
  exact({ ...candidateShape, usernameFragment: nullable(text(0, 256)) })(v);

const SIGNALS: Record<Signal['kind'], Check> = {
  offer: exact({ kind: () => true, connId: b64(16), sdp: text(1, MAX_SDP), cO: b64(32) }),
  answer: exact({ kind: () => true, connId: b64(16), sdp: text(1, MAX_SDP), nA: b64(16) }),
  ice: exact({ kind: () => true, connId: b64(16), candidate }),
};

/** Strict boundary check for a signaling message; null for anything else. */
export function parseSignal(value: unknown): Signal | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !Object.hasOwn(SIGNALS, kind)) return null;
  return SIGNALS[kind as Signal['kind']](value) ? (value as Signal) : null;
}

/** STUN servers from build-time config (SD-11); TURN and other schemes are ignored. */
export function iceServers(value: string | undefined): RTCIceServer[] {
  const urls = (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^stuns?:[^\s]+$/.test(url));
  return urls.length ? [{ urls }] : [];
}

export interface PeerOptions {
  role: 'offerer' | 'answerer';
  iceServers: RTCIceServer[];
  send: (signal: Signal) => void;
  onSession: (session: Session) => void;
  files?: File[];
  receiveCap?: number;
}

/**
 * One RTCPeerConnection with a single negotiated, ordered, reliable DataChannel. Exactly one
 * offer/answer exchange is applied; any later description is refused and the connection fails
 * closed, because renegotiation could change the DTLS fingerprints the SAS was computed from.
 */
export function createPeer(o: PeerOptions) {
  const pc = new RTCPeerConnection({ iceServers: o.iceServers });
  const channel = pc.createDataChannel('zipply', { negotiated: true, id: 0, ordered: true });
  let connId: Uint8Array | null = o.role === 'offerer' ? randomBytes(16) : null;
  let session: Session | null = null;
  let pending: { nO: Uint8Array; cO: Uint8Array } | null = null;
  let described = false;
  let queue = Promise.resolve();
  const timer = setTimeout(() => {
    if (channel.readyState !== 'open') close();
  }, CONNECT_TIMEOUT_MS);

  const sessionOptions = {
    channel,
    sdp: () => ({
      local: pc.currentLocalDescription?.sdp,
      remote: pc.currentRemoteDescription?.sdp,
    }),
    maxMessageSize: () => pc.sctp?.maxMessageSize,
    receiveCap: o.receiveCap,
    onClose: () => pc.close(),
  };

  function close() {
    clearTimeout(timer);
    session?.lost();
    pc.close();
  }

  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (!candidate || !connId) return;
    o.send({
      kind: 'ice',
      connId: toB64url(connId),
      candidate: candidate.toJSON() as IceCandidate,
    });
  });
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') clearTimeout(timer);
    if (pc.connectionState === 'failed') close();
  });

  async function handle(signal: Signal) {
    const ownConn = connId !== null && signal.connId === toB64url(connId);
    if (signal.kind === 'ice') {
      if (ownConn && described) await pc.addIceCandidate(signal.candidate);
      return;
    }
    if (described) return close(); // renegotiation guard
    described = true;

    if (signal.kind === 'offer' && o.role === 'answerer' && connId === null) {
      connId = fromB64url(signal.connId)!;
      const cO = fromB64url(signal.cO)!;
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await pc.setLocalDescription();
      const nA = randomBytes(16);
      session = createSession({ ...sessionOptions, role: 'answerer', secrets: { connId, cO, nA } });
      o.onSession(session);
      o.send({
        kind: 'answer',
        connId: signal.connId,
        sdp: pc.localDescription!.sdp,
        nA: toB64url(nA),
      });
    } else if (signal.kind === 'answer' && o.role === 'offerer' && ownConn && pending) {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      const { nO, cO } = pending;
      session = createSession({
        ...sessionOptions,
        role: 'offerer',
        secrets: { connId: connId!, cO, nO, nA: fromB64url(signal.nA)! },
        files: o.files,
      });
      o.onSession(session);
    } else {
      close();
    }
  }

  return {
    /** Offerer: creates the offer with the SAS commitment cO (the nonce nO stays local until reveal). */
    async start() {
      const nO = randomBytes(16);
      const cO = await commit(connId!, nO);
      pending = { nO, cO };
      await pc.setLocalDescription();
      o.send({
        kind: 'offer',
        connId: toB64url(connId!),
        sdp: pc.localDescription!.sdp,
        cO: toB64url(cO),
      });
    },
    /** Serialized so ICE candidates are never applied before the description they belong to. */
    handle(signal: Signal) {
      queue = queue.then(() => handle(signal)).catch(close);
    },
    close,
  };
}
