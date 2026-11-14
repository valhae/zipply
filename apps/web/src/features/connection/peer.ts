import type { ClientMessage, IceCandidate } from '@zipply/protocol';
import { commit, fromB64url, parseFingerprints, randomBytes, toB64url } from './sas';
import { createSession, type Session } from './session';

/**
 * Signaling messages for one connection (SD-02 steps 1–2), already validated at the WebSocket
 * boundary by @zipply/protocol. SDP and candidates are sensitive network metadata: never log,
 * display or persist them.
 */
export type Signal = Extract<ClientMessage, { type: 'offer' | 'answer' | 'ice-candidate' }>;

const CONNECT_TIMEOUT_MS = 30_000;
// P6-04: after a failure (or 5 s disconnected) the offerer restarts ICE, at most twice; without
// recovery within 30 s the connection closes and a transfer in progress pauses.
const DISCONNECTED_GRACE_MS = 5000;
const ICE_RECOVERY_MS = 30_000;
const MAX_ICE_RESTARTS = 2;

/** STUN servers from build-time config (SD-11); TURN and other schemes are ignored. */
export function iceServers(value: string | undefined): RTCIceServer[] {
  const urls = (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^stuns?:[^\s]+$/.test(url));
  return urls.length ? [{ urls }] : [];
}

/** Hostnames of the STUN servers, for the IP disclosure (P5-09); they see this device's address. */
export const stunHosts = (servers: RTCIceServer[]) =>
  servers.flatMap((s) => [s.urls].flat()).map((url) => url.replace(/^stuns?:|:\d+$/g, ''));

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
  /** A paused transfer to continue on this new connection, after a new word check (P6-05). */
  resume?: Session;
}

/** The selected route for the debug panel: candidate types and protocol, never addresses. */
export async function routeStats(pc: RTCPeerConnection) {
  const report = await pc.getStats();
  let pair: Record<string, unknown> | undefined;
  report.forEach((s: Record<string, unknown>) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      pair = report.get(s.selectedCandidatePairId as string) as Record<string, unknown>;
    }
  });
  const end = (id: unknown) => report.get(id as string) as Record<string, unknown> | undefined;
  const local = pair && end(pair.localCandidateId);
  const remote = pair && end(pair.remoteCandidateId);
  const route =
    local && remote
      ? `${String(local.candidateType)} → ${String(remote.candidateType)} (${String(local.protocol)})`
      : 'unknown';
  return { ice: pc.iceConnectionState, route };
}

/**
 * One RTCPeerConnection with a single negotiated, ordered, reliable DataChannel. One offer/answer
 * exchange sets it up. A later description is accepted only as an ICE restart of this same
 * connection (same connId, commitment and nonce, same DTLS fingerprints, P6-04); anything else is
 * refused and the connection fails closed, because it could change the keys the SAS covers.
 */
export function createPeer(o: PeerOptions) {
  const { requestId } = o;
  const pc = new RTCPeerConnection({ iceServers: o.iceServers });
  const channel = pc.createDataChannel('zipply', { negotiated: true, id: 0, ordered: true });
  let connId: Uint8Array | null = o.role === 'offerer' ? randomBytes(16) : null;
  let session: Session | null = null;
  let pending: { nO: Uint8Array; cO: Uint8Array } | null = null;
  let described = false;
  // For ICE restarts: this connection's commitment and answer nonce, as sent the first time.
  let cOText: string | null = null;
  let nAText: string | null = null;
  let restarting = false;
  let restarts = 0;
  let recovery: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
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
    onClose: () => pc.close(),
    stats: () => routeStats(pc).catch(() => null),
  };

  /** A new session, or the paused one (it refuses if it cannot resume, and we close). */
  function startSession(opts: Parameters<typeof createSession>[0]) {
    if (o.resume && !o.resume.attach(opts)) return close();
    session = o.resume ?? createSession(opts);
    o.onSession(session);
  }

  let closed = false;
  function close() {
    clearTimeout(timer);
    clearTimeout(recovery);
    clearTimeout(grace);
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
    const state = pc.connectionState;
    if (state === 'connected') {
      for (const t of [timer, recovery, grace]) clearTimeout(t);
      recovery = grace = undefined;
      restarts = 0;
      return;
    }
    if (state !== 'failed' && state !== 'disconnected') return;
    if (channel.readyState !== 'open') {
      if (state === 'failed') close();
      return;
    }
    recovery ??= setTimeout(close, ICE_RECOVERY_MS);
    if (state === 'failed') restart();
    else {
      grace ??= setTimeout(() => {
        grace = undefined;
        if (pc.connectionState !== 'connected') restart();
      }, DISCONNECTED_GRACE_MS);
    }
  });

  /** Offerer: ICE restart over signaling; the DTLS association and its fingerprints stay. */
  function restart() {
    if (o.role !== 'offerer' || !cOText || restarts >= MAX_ICE_RESTARTS) return;
    restarts++;
    queue = queue
      .then(async () => {
        restarting = true;
        pc.restartIce();
        await pc.setLocalDescription();
        o.send({
          type: 'offer',
          payload: {
            requestId,
            connId: toB64url(connId!),
            sdp: pc.localDescription!.sdp,
            cO: cOText!,
          },
        });
      })
      .catch(close);
  }

  const sameFingerprints = (sdp: string) => {
    const next = parseFingerprints(sdp);
    const now = parseFingerprints(pc.currentRemoteDescription?.sdp ?? '');
    return !!next && !!now && next.map(toB64url).join('.') === now.map(toB64url).join('.');
  };

  async function renegotiate({
    type,
    payload: signal,
  }: Exclude<Signal, { type: 'ice-candidate' }>) {
    const same =
      connId !== null && signal.connId === toB64url(connId) && sameFingerprints(signal.sdp);
    if (type === 'offer' && o.role === 'answerer' && same && signal.cO === cOText && nAText) {
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await pc.setLocalDescription();
      o.send({
        type: 'answer',
        payload: { requestId, connId: signal.connId, sdp: pc.localDescription!.sdp, nA: nAText },
      });
    } else if (
      type === 'answer' &&
      o.role === 'offerer' &&
      restarting &&
      same &&
      signal.nA === nAText
    ) {
      restarting = false;
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else {
      close(); // renegotiation guard
    }
  }

  async function handle(message: Signal) {
    const { type, payload: signal } = message;
    if (signal.requestId !== requestId) return;
    const ownConn = connId !== null && signal.connId === toB64url(connId);
    if (type === 'ice-candidate') {
      if (ownConn && described) await pc.addIceCandidate(signal.candidate);
      return;
    }
    if (described) return renegotiate(message as Exclude<Signal, { type: 'ice-candidate' }>);
    described = true;

    if (type === 'offer' && o.role === 'answerer' && connId === null) {
      connId = fromB64url(signal.connId)!;
      const cO = fromB64url(signal.cO)!;
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await pc.setLocalDescription();
      const nA = randomBytes(16);
      cOText = signal.cO;
      nAText = toB64url(nA);
      startSession({ ...sessionOptions, role: 'answerer', secrets: { connId, cO, nA } });
      if (closed) return;
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
      nAText = signal.nA;
      startSession({
        ...sessionOptions,
        role: 'offerer',
        secrets: { connId: connId!, cO, nO, nA: fromB64url(signal.nA)! },
        files: o.files,
      });
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
      cOText = toB64url(cO);
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
