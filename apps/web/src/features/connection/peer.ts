import type { ClientMessage, IceCandidate } from '@zipply/protocol';
import { commit, fromB64url, randomBytes, toB64url } from './sas';
import { createSession, type Session } from './session';

/**
 * Signaling messages for one connection (SD-02 steps 1–2), already validated at the WebSocket
 * boundary by @zipply/protocol. SDP and candidates are sensitive network metadata: never log,
 * display or persist them.
 */
export type Signal = Extract<ClientMessage, { type: 'offer' | 'answer' | 'ice-candidate' }>;

const CONNECT_TIMEOUT_MS = 30_000;

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
  /** The signaling request this connection belongs to; stamped on every outgoing signal. */
  requestId: string;
  iceServers: RTCIceServer[];
  send: (signal: Signal) => void;
  onSession: (session: Session) => void;
  /** The connection closed (failure, timeout or close()). */
  onClosed?: () => void;
  files?: File[];
  receiveCap?: number;
}

/**
 * One RTCPeerConnection with a single negotiated, ordered, reliable DataChannel. Exactly one
 * offer/answer exchange is applied; any later description is refused and the connection fails
 * closed, because renegotiation could change the DTLS fingerprints the SAS was computed from.
 */
export function createPeer(o: PeerOptions) {
  const { requestId } = o;
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

  let closed = false;
  function close() {
    clearTimeout(timer);
    session?.lost();
    pc.close();
    if (!closed) o.onClosed?.();
    closed = true;
  }

  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (!candidate || !connId) return;
    o.send({
      type: 'ice-candidate',
      payload: {
        requestId,
        connId: toB64url(connId),
        candidate: candidate.toJSON() as IceCandidate,
      },
    });
  });
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') clearTimeout(timer);
    if (pc.connectionState === 'failed') close();
  });

  async function handle({ type, payload: signal }: Signal) {
    if (signal.requestId !== requestId) return;
    const ownConn = connId !== null && signal.connId === toB64url(connId);
    if (type === 'ice-candidate') {
      if (ownConn && described) await pc.addIceCandidate(signal.candidate);
      return;
    }
    if (described) return close(); // renegotiation guard
    described = true;

    if (type === 'offer' && o.role === 'answerer' && connId === null) {
      connId = fromB64url(signal.connId)!;
      const cO = fromB64url(signal.cO)!;
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await pc.setLocalDescription();
      const nA = randomBytes(16);
      session = createSession({ ...sessionOptions, role: 'answerer', secrets: { connId, cO, nA } });
      o.onSession(session);
      o.send({
        type: 'answer',
        payload: {
          requestId,
          connId: signal.connId,
          sdp: pc.localDescription!.sdp,
          nA: toB64url(nA),
        },
      });
    } else if (type === 'answer' && o.role === 'offerer' && ownConn && pending) {
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
        type: 'offer',
        payload: {
          requestId,
          connId: toB64url(connId!),
          sdp: pc.localDescription!.sdp,
          cO: toB64url(cO),
        },
      });
    },
    /** Serialized so ICE candidates are never applied before the description they belong to. */
    handle(signal: Signal) {
      queue = queue.then(() => handle(signal)).catch(close);
    },
    close,
  };
}
