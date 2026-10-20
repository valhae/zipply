import { isValidDisplayName } from '@zipply/protocol';
import { IDLE_LINK, createLink, type Link, type LinkSnapshot } from '../connection/link';
import { OFFLINE, createPresence, type Presence, type PresenceSnapshot } from './presence';
import type { Room } from './room';

export interface DiscoverySnapshot {
  presence: PresenceSnapshot;
  link: LinkSnapshot;
  room: Room | null;
  /** The name others see: a fresh auto name each visit, or one the user chose. */
  name: string;
  customName: boolean;
  discoverable: boolean;
}

interface Options {
  url: string | undefined;
  /** A name the user chose earlier (kept on this device); null for a fresh auto name. */
  customName: string | null;
  iceServers: RTCIceServer[];
  WebSocket?: typeof WebSocket;
}

const NAME_KEY = 'zipply-name';

/** A name the user chose earlier on this device; null if none, invalid or storage is blocked. */
export function storedName(): string | null {
  try {
    const name = localStorage.getItem(NAME_KEY);
    return name !== null && isValidDisplayName(name) ? name : null;
  } catch {
    return null;
  }
}

export function rememberName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // storage blocked: the name still applies for this visit
  }
}

export function forgetName() {
  try {
    localStorage.removeItem(NAME_KEY);
  } catch {
    // storage blocked: nothing was kept
  }
}

// One-word, pixel-flavoured auto names: two different bases, no digits (40 × 39 = 1,560 combinations).
const BASES = [
  'Pixl',
  'Voxl',
  'Bitz',
  'Blip',
  'Zapp',
  'Glyf',
  'Dotz',
  'Chip',
  'Nibl',
  'Rezz',
  'Lumo',
  'Moxi',
  'Fizz',
  'Tekk',
  'Flux',
  'Kilo',
  'Byte',
  'Nano',
  'Pico',
  'Mega',
  'Zigg',
  'Quix',
  'Jinx',
  'Pong',
  'Blox',
  'Krux',
  'Vexx',
  'Pyxl',
  'Hexa',
  'Octo',
  'Cubi',
  'Grid',
  'Lynx',
  'Arca',
  'Zeno',
  'Koda',
  'Yoxi',
  'Dash',
  'Bolt',
  'Spry',
];
/** A fresh auto name such as "VoxlByte"; a new one every visit so it never works as a tracking ID. */
export function randomPixelName(): string {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  const first = a! % BASES.length;
  // Offset 1..39 so the second word always differs from the first.
  return `${BASES[first]}${BASES[(first + 1 + (b! % (BASES.length - 1))) % BASES.length]}`;
}

const MAX_AUTO_RETRIES = 5;

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
  let name = o.customName ?? randomPixelName();
  let customName = o.customName !== null;
  let handledTaken = false;
  let autoRetries = 0;
  const snapshot = (p: PresenceSnapshot, l: LinkSnapshot): DiscoverySnapshot => ({
    presence: p,
    link: l,
    room,
    name,
    customName,
    discoverable,
  });
  let snap = snapshot(OFFLINE, IDLE_LINK);

  const refresh = () => {
    const p = presence!.getSnapshot();
    if (p.nameTaken && !handledTaken) {
      handledTaken = true;
      // An auto name just picks another; a chosen name stays, hidden, until the user changes it.
      if (!customName && autoRetries < MAX_AUTO_RETRIES) {
        autoRetries++;
        name = randomPixelName();
        return start();
      }
      discoverable = false;
    }
    if (!p.nameTaken) handledTaken = false;
    if (p.status === 'online' && !p.nameTaken) autoRetries = 0;
    snap = snapshot(p, link!.getSnapshot());
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
      displayName: name,
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
      snap = { ...snap, discoverable };
      listeners.forEach((fn) => fn());
    },
    /** Switches between the public lobby (null) and a private room; reconnects if running. */
    setRoom(next: Room | null) {
      room = next;
      if (presence) start();
      else snap = { ...snap, room };
    },
    /** The name is part of hello, so a rename reconnects. Callers block it during a connection. */
    setDisplayName(next: string) {
      name = next;
      customName = true;
      if (presence) start();
      else snap = { ...snap, name, customName };
    },
    /** Back to a fresh auto name. */
    randomName() {
      name = randomPixelName();
      customName = false;
      if (presence) start();
      else snap = { ...snap, name, customName };
    },
    retry: () => presence?.retry(),
    request: (peerId: string, name: string, files: File[]) => link?.request(peerId, name, files),
    accept: () => link?.accept(),
    decline: () => link?.decline(),
    cancel: () => link?.cancel(),
    dismiss: () => link?.dismiss(),
  };
}
