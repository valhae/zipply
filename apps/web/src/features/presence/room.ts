import { fromB64url, randomBytes, sha256, toB64url } from '../connection/sas';

export interface Room {
  /** Secret: lives only in the URL fragment and the hello message, never in a path, query or log. */
  capability: string;
  /** base64url(SHA-256(capability)): the only part that appears in the WebSocket path. */
  hash: string;
  expiresAt: number;
}

const MINUTE = 60_000;
const FRAGMENT = /^#room=([A-Za-z0-9_-]{27})$/;

async function fromBytes(bytes: Uint8Array): Promise<Room> {
  const expiresAt = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16) * MINUTE;
  return { capability: toB64url(bytes), hash: toB64url(await sha256(bytes)), expiresAt };
}

/** SD-05: 16 random bytes + expiry as epoch minutes (u32 BE). Default lifetime 30 minutes. */
export function createRoom(minutes = 30, now = Date.now()): Promise<Room> {
  const bytes = new Uint8Array(20);
  bytes.set(randomBytes(16));
  new DataView(bytes.buffer).setUint32(16, Math.floor(now / MINUTE) + minutes);
  return fromBytes(bytes);
}

/** Reads `#room=<capability>`; null unless well formed and unexpired. */
export async function readRoom(fragment: string, now = Date.now()): Promise<Room | null> {
  const bytes = fromB64url(FRAGMENT.exec(fragment)?.[1] ?? '');
  if (bytes?.length !== 20) return null;
  const room = await fromBytes(bytes);
  return room.expiresAt > now ? room : null;
}
