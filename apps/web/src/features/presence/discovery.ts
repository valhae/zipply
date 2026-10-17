import { IDLE_LINK, createLink, type Link, type LinkSnapshot } from '../connection/link';
import { OFFLINE, createPresence, type Presence, type PresenceSnapshot } from './presence';
import type { Room } from './room';

export interface DiscoverySnapshot {
  presence: PresenceSnapshot;
  link: LinkSnapshot;
  room: Room | null;
}

interface Options {
  url: string | undefined;
  displayName: string;
  iceServers: RTCIceServer[];
  WebSocket?: typeof WebSocket;
}

export const randomDisplayName = () =>
  `Guest ${String(crypto.getRandomValues(new Uint32Array(1))[0]! % 10_000).padStart(4, '0')}`;

/**
 * Owns the presence connection and the connection-request flow for the current scope (lobby or a
 * private room). Side-effect free until start(), so React can create it in render and open the
 * socket in an effect.
 */
export function createDiscovery(o: Options) {
  const listeners = new Set<() => void>();
  let presence: Presence | null = null;
  let link: Link | null = null;
  let unsubscribe: (() => void)[] = [];
  let room: Room | null = null;
  let discoverable = false;
  let snap: DiscoverySnapshot = { presence: OFFLINE, link: IDLE_LINK, room };

  const refresh = () => {
    snap = { presence: presence!.getSnapshot(), link: link!.getSnapshot(), room };
    listeners.forEach((fn) => fn());
  };

  function stop() {
    unsubscribe.forEach((fn) => fn());
    unsubscribe = [];
    link?.dispose();
    presence?.close();
    link = presence = null;
  }

  function start() {
    stop();
    presence = createPresence({
      url: o.url,
      displayName: o.displayName,
      discoverable,
      WebSocket: o.WebSocket,
      ...(room ? { room: { capability: room.capability, hash: room.hash } } : {}),
    });
    link = createLink({ presence, iceServers: o.iceServers });
    unsubscribe = [presence.subscribe(refresh), link.subscribe(refresh)];
    refresh();
  }

  return {
    start,
    stop,
    getSnapshot: () => snap,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setDiscoverable(next: boolean) {
      discoverable = next;
      presence?.setDiscoverable(next);
    },
    /** Switches between the public lobby (null) and a private room; reconnects if running. */
    setRoom(next: Room | null) {
      room = next;
      if (presence) start();
      else snap = { ...snap, room };
    },
    retry: () => presence?.retry(),
    request: (peerId: string, name: string, files: File[]) => link?.request(peerId, name, files),
    accept: () => link?.accept(),
    decline: () => link?.decline(),
    cancel: () => link?.cancel(),
    dismiss: () => link?.dismiss(),
  };
}
