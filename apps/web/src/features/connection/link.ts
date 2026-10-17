import type { ClientMessage, ServerMessage } from '@zipply/protocol';
import { createPeer as realCreatePeer, type PeerOptions, type Signal } from './peer';
import { randomBytes, toB64url } from './sas';
import type { Session } from './session';

export interface LinkSnapshot {
  phase: 'idle' | 'requesting' | 'incoming' | 'connecting' | 'session' | 'ended';
  requestId: string | null;
  peerId: string | null;
  peerName: string | null;
  role: 'offerer' | 'answerer' | null;
  session: Session | null;
  expiresAt: number | null;
  notice: 'declined' | 'unavailable' | 'expired' | 'canceled' | null;
}

type PeerHandle = { start(): Promise<void>; handle(s: Signal): void; close(): void };

export interface LinkOptions {
  presence: {
    send(m: ClientMessage): boolean;
    onMessage(fn: (m: ServerMessage) => void): () => void;
  };
  iceServers: RTCIceServer[];
  createPeer?: (o: PeerOptions) => PeerHandle;
}

export type Link = ReturnType<typeof createLink>;

export const IDLE_LINK: LinkSnapshot = {
  phase: 'idle',
  requestId: null,
  peerId: null,
  peerName: null,
  role: null,
  session: null,
  expiresAt: null,
  notice: null,
};

/**
 * One connection at a time over signaling: request → response → offer/answer/ICE → DataChannel
 * session. Only a local user action (request, accept) can start a connection. A signaling `cancel`
 * is advisory (SD-04): it may stop a connection, never start or accept one.
 */
export function createLink(o: LinkOptions) {
  const createPeer = o.createPeer ?? realCreatePeer;
  const listeners = new Set<() => void>();
  let snap = IDLE_LINK;
  let peer: PeerHandle | null = null;
  let files: File[] = [];
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const update = (next: Partial<LinkSnapshot>) => {
    snap = { ...snap, ...next };
    listeners.forEach((fn) => fn());
  };
  const end = (notice: LinkSnapshot['notice']) => {
    clearTimeout(expiry);
    const p = peer;
    peer = null;
    p?.close();
    update({ phase: 'ended', notice });
  };

  function startPeer(role: 'offerer' | 'answerer') {
    const requestId = snap.requestId!;
    update({ phase: 'connecting', role });
    const p = createPeer({
      role,
      requestId,
      iceServers: o.iceServers,
      files: role === 'offerer' ? files : undefined,
      send: (signal) => o.presence.send(signal),
      onSession: (session) => update({ phase: 'session', session }),
      onClosed: () => {
        if (peer === p && snap.phase === 'connecting') end('unavailable');
      },
    });
    peer = p;
    if (role === 'offerer') void p.start().catch(() => end('unavailable'));
  }

  const off = o.presence.onMessage((m) => {
    const ours = 'requestId' in m.payload && m.payload.requestId === snap.requestId;
    switch (m.type) {
      case 'connection-request':
        if (snap.phase !== 'idle') {
          o.presence.send({
            type: 'connection-response',
            payload: { requestId: m.payload.requestId, accept: false },
          });
          return;
        }
        update({
          ...IDLE_LINK,
          phase: 'incoming',
          requestId: m.payload.requestId,
          peerId: m.payload.fromPeerId,
          peerName: m.payload.displayName,
          expiresAt: m.payload.expiresAt,
        });
        clearTimeout(expiry);
        expiry = setTimeout(
          () => snap.phase === 'incoming' && end('expired'),
          m.payload.expiresAt - Date.now(),
        );
        return;
      case 'connection-response':
        if (!ours || snap.phase !== 'requesting') return;
        if (m.payload.accept) startPeer('offerer');
        else end('declined');
        return;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        if (ours) peer?.handle(m);
        return;
      case 'cancel':
        if (ours && ['requesting', 'incoming', 'connecting', 'session'].includes(snap.phase)) {
          if (snap.phase === 'session') peer?.close();
          else end('canceled');
        }
        return;
      case 'error':
        if (snap.phase === 'requesting')
          end(m.payload.code === 'REQUEST_EXPIRED' ? 'expired' : 'unavailable');
    }
  });

  return {
    getSnapshot: () => snap,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Local action: ask a discoverable peer to connect. Files stay local until after the SAS. */
    request(peerId: string, peerName: string, selected: File[]) {
      if (snap.phase !== 'idle') return;
      files = selected;
      const requestId = toB64url(randomBytes(16));
      update({ ...IDLE_LINK, phase: 'requesting', requestId, peerId, peerName });
      const sent = o.presence.send({
        type: 'connection-request',
        payload: { requestId, targetPeerId: peerId },
      });
      if (!sent) end('unavailable');
    },
    /** Local action: accept the incoming connection (not the files; that comes after the SAS). */
    accept() {
      if (snap.phase !== 'incoming') return;
      clearTimeout(expiry);
      o.presence.send({
        type: 'connection-response',
        payload: { requestId: snap.requestId!, accept: true },
      });
      startPeer('answerer');
    },
    decline() {
      if (snap.phase !== 'incoming') return;
      clearTimeout(expiry);
      o.presence.send({
        type: 'connection-response',
        payload: { requestId: snap.requestId!, accept: false },
      });
      update(IDLE_LINK);
    },
    /** Withdraws a request or stops a connection; an active transfer is canceled on its DataChannel too. */
    cancel() {
      if (snap.phase === 'idle' || snap.phase === 'ended') return;
      if (snap.phase === 'incoming') return this.decline();
      o.presence.send({ type: 'cancel', payload: { requestId: snap.requestId! } });
      if (snap.phase === 'session') return snap.session?.cancel();
      clearTimeout(expiry);
      const p = peer;
      peer = null;
      p?.close();
      update(IDLE_LINK);
    },
    /** Clears a finished attempt and releases its resources. */
    dismiss() {
      clearTimeout(expiry);
      snap.session?.dispose();
      const p = peer;
      peer = null;
      p?.close();
      update(IDLE_LINK);
    },
    dispose() {
      off();
      this.dismiss();
    },
  };
}
