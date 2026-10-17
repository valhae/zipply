import {
  PING,
  PONG,
  encodeMessage,
  parseServerMessage,
  type ClientMessage,
  type Peer,
  type ServerMessage,
} from '@zipply/protocol';
import type { Connection } from '../radar/status';
import { signalingUrlProblem } from './url';

export { signalingUrlProblem };

export interface PresenceOptions {
  url: string | undefined;
  displayName: string;
  discoverable: boolean;
  room?: { capability: string; hash: string };
  WebSocket?: typeof WebSocket;
  random?: () => number;
}

export interface PresenceSnapshot {
  status: Connection;
  /** Repeated failures or SERVER_BUSY: show "Discovery temporarily unavailable" (P4-09). */
  unavailable: boolean;
  roomInvalid: boolean;
  /** The server kept us hidden because a visible peer here already uses this name. */
  nameTaken: boolean;
  selfId: string | null;
  peers: Peer[];
}

export type Presence = ReturnType<typeof createPresence>;

export const OFFLINE: PresenceSnapshot = {
  status: 'offline',
  unavailable: false,
  roomInvalid: false,
  nameTaken: false,
  selfId: null,
  peers: [],
};

const MAX_BACKOFF_MS = 30_000;
const UNAVAILABLE_AFTER = 3;
const OPEN = 1;

/**
 * Live presence over one WebSocket: hello, snapshot and join/leave events, heartbeat pings answered
 * by the server's auto-response, and reconnects with exponential backoff and jitter. It never invents
 * peers: the list only ever contains what the server announced on the current connection.
 */
export function createPresence(o: PresenceOptions) {
  const Socket = o.WebSocket ?? WebSocket;
  const random = o.random ?? Math.random;
  const listeners = new Set<() => void>();
  const handlers = new Set<(m: ServerMessage) => void>();
  let snap = OFFLINE;
  let discoverable = o.discoverable;
  let ws: WebSocket | null = null;
  let failures = 0;
  let everOnline = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let aliveAt = 0;

  const update = (patch: Partial<PresenceSnapshot>) => {
    snap = { ...snap, ...patch };
    listeners.forEach((fn) => fn());
  };

  function connect() {
    clearTimeout(retryTimer);
    const socket = new Socket(o.room ? `${o.url}/${o.room.hash}` : o.url!);
    ws = socket;
    update({
      status: snap.unavailable ? 'offline' : everOnline ? 'reconnecting' : 'connecting',
      selfId: null,
      peers: [],
      nameTaken: false,
    });
    socket.onopen = () => {
      aliveAt = Date.now();
      const room = o.room ? { room: o.room.capability } : {};
      socket.send(
        encodeMessage({
          type: 'hello',
          payload: { displayName: o.displayName, discoverable, ...room },
        }),
      );
    };
    socket.onmessage = (e: MessageEvent) => {
      if (ws !== socket || typeof e.data !== 'string') return;
      aliveAt = Date.now();
      if (e.data === PONG) return;
      const parsed = parseServerMessage(e.data);
      if (parsed.ok) receive(parsed.message);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      clearInterval(heartbeat);
      if (stopped || snap.roomInvalid) {
        return update({ status: 'offline', selfId: null, peers: [], nameTaken: false });
      }
      failures++;
      const unavailable = snap.unavailable || failures >= UNAVAILABLE_AFTER;
      update({
        status: unavailable ? 'offline' : everOnline ? 'reconnecting' : 'connecting',
        unavailable,
        selfId: null,
        peers: [],
        nameTaken: false,
      });
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)) * (0.5 + random());
      retryTimer = setTimeout(connect, delay);
    };
  }

  function receive(m: ServerMessage) {
    switch (m.type) {
      case 'hello-accepted': {
        failures = 0;
        everOnline = true;
        const seconds = Math.min(120, Math.max(5, m.payload.heartbeatSeconds));
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (Date.now() - aliveAt > (seconds * 2 + 5) * 1000) return ws?.close();
          ws?.send(PING);
        }, seconds * 1000);
        return update({ status: 'online', unavailable: false, selfId: m.payload.peerId });
      }
      case 'peer-snapshot':
        return update({ peers: m.payload.peers });
      case 'peer-joined': {
        const { peer } = m.payload;
        return update({ peers: [...snap.peers.filter((p) => p.peerId !== peer.peerId), peer] });
      }
      case 'peer-left':
        return update({ peers: snap.peers.filter((p) => p.peerId !== m.payload.peerId) });
      case 'error':
        if (m.payload.code === 'SERVER_BUSY') update({ unavailable: true });
        if (m.payload.code === 'ROOM_INVALID') update({ roomInvalid: true });
        if (m.payload.code === 'NAME_TAKEN') update({ nameTaken: true });
    }
    handlers.forEach((fn) => fn(m));
  }

  if (signalingUrlProblem(o.url) === null) connect();

  return {
    getSnapshot: () => snap,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Server messages other than presence: requests, responses, signals, cancels and errors. */
    onMessage(fn: (m: ServerMessage) => void) {
      handlers.add(fn);
      return () => void handlers.delete(fn);
    },
    setDiscoverable(next: boolean) {
      discoverable = next;
      if (snap.nameTaken) update({ nameTaken: false });
      if (snap.status === 'online') {
        ws?.send(encodeMessage({ type: 'visibility', payload: { discoverable } }));
      }
    },
    send(m: ClientMessage): boolean {
      if (!ws || ws.readyState !== OPEN || !snap.selfId) return false;
      ws.send(encodeMessage(m));
      return true;
    },
    retry() {
      if (stopped || snap.roomInvalid || signalingUrlProblem(o.url) !== null) return;
      failures = 0;
      const old = ws;
      ws = null;
      old?.close();
      connect();
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(heartbeat);
      const old = ws;
      ws = null;
      old?.close();
      update({ status: 'offline', selfId: null, peers: [] });
    },
  };
}
