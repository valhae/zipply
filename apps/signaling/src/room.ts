import {
  HEARTBEAT_SECONDS,
  MAX_PEERS,
  PING,
  PONG,
  PRESENCE_TTL_SECONDS,
  REQUEST_TTL_SECONDS,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type Peer,
  type ServerMessage,
} from '@zipply/protocol';
import { DurableObject } from 'cloudflare:workers';

export const MAX_SOCKETS = MAX_PEERS;
export const MAX_PENDING = 10;
const SWEEP_MS = 60_000;
// Token bucket per socket: bursts of 40 (ICE trickle), 5 messages/s sustained.
const BUCKET = 40;
const REFILL_PER_SECOND = 5;
const MAX_VIOLATIONS = 50;
const CLOSE_POLICY = 1008;
const CLOSE_BUSY = 1013;
const CLOSE_EXPIRED = 4000;

interface Pending {
  id: string;
  peer: string;
  role: 'requester' | 'target';
  accepted: boolean;
  expiresAt: number;
}

/** Everything a socket needs survives hibernation here (≤ 16 KiB); nothing goes to storage. */
export interface Attachment {
  room: string; // private-room route hash, '' for the public lobby
  peerId?: string;
  name?: string;
  discoverable: boolean;
  seenAt: number;
  tokens: number;
  violations: number;
  pending: Pending[];
  left?: boolean;
}

type Live = { ws: WebSocket; att: Attachment };
type Relayed = Extract<ClientMessage, { type: 'offer' | 'answer' | 'ice-candidate' | 'cancel' }>;

const read = (ws: WebSocket) => ws.deserializeAttachment() as Attachment;
const write = (ws: WebSocket, att: Attachment) => ws.serializeAttachment(att);

const nameKey = (name: string) => name.normalize('NFKC').toLowerCase();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** SD-05: 16 random bytes + expiry (epoch minutes, u32 BE); the route is base64url(SHA-256(capability)). */
async function capabilityValid(capability: string, routeHash: string): Promise<boolean> {
  const bytes = Uint8Array.from(atob(capability.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  if (bytes.length !== 20) return false;
  const expiresMinute = new DataView(bytes.buffer).getUint32(16);
  if (expiresMinute * 60_000 <= Date.now()) return false;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return b64url(hash) === routeHash;
}

/**
 * One scope (the public lobby or one private room). Presence is rebuilt from live sockets and their
 * attachments on every call, so it is correct after hibernation. No SQL or key/value storage is used;
 * `setAlarm` is only a timer for the lease sweep (D2).
 */
export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const busy = this.live().length >= MAX_SOCKETS;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    write(server, {
      room: request.headers.get('x-zipply-room') ?? '',
      discoverable: false,
      seenAt: now,
      tokens: BUCKET,
      violations: 0,
      pending: [],
    });
    if (busy) this.reject(server, 'SERVER_BUSY', CLOSE_BUSY);
    else if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + SWEEP_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const att = read(ws);
    if (att.left) return;
    const now = Date.now();
    att.tokens = Math.min(BUCKET, att.tokens + ((now - att.seenAt) / 1000) * REFILL_PER_SECOND);
    att.seenAt = now;
    if (att.tokens < 1) {
      att.violations++;
      write(ws, att);
      if (att.violations > MAX_VIOLATIONS) this.reject(ws, 'RATE_LIMITED', CLOSE_POLICY);
      else if (att.violations === 1) this.error(ws, 'RATE_LIMITED');
      return;
    }
    att.tokens -= 1;
    att.violations = 0;
    write(ws, att);

    // Binary frames are refused: no file data ever passes through signaling.
    const parsed = typeof data === 'string' ? parseClientMessage(data) : null;
    if (!parsed?.ok) return this.reject(ws, parsed?.code ?? 'INVALID_MESSAGE', CLOSE_POLICY);
    const m = parsed.message;
    if (!att.peerId) {
      if (m.type === 'hello') return this.hello(ws, m.payload);
      return this.reject(ws, 'INVALID_MESSAGE', CLOSE_POLICY);
    }
    switch (m.type) {
      case 'hello':
        return this.reject(ws, 'INVALID_MESSAGE', CLOSE_POLICY);
      case 'visibility':
        return this.visibility(ws, att, m.payload.discoverable);
      case 'connection-request':
        return this.request(ws, att, m.payload.requestId, m.payload.targetPeerId);
      case 'connection-response':
        return this.respond(ws, att, m.payload.requestId, m.payload.accept);
      default:
        return this.relay(ws, att, m);
    }
  }

  override webSocketClose(ws: WebSocket) {
    this.leave(ws);
  }

  override webSocketError(ws: WebSocket) {
    this.leave(ws);
  }

  /** Lease sweep: close sockets silent (no message, no auto-response ping) for longer than the TTL. */
  override async alarm() {
    const now = Date.now();
    for (const { ws, att } of this.live()) {
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(att.seenAt, pinged) > PRESENCE_TTL_SECONDS * 1000) {
        this.leave(ws, CLOSE_EXPIRED);
        continue;
      }
      const kept = att.pending.filter((p) => p.expiresAt > now);
      if (kept.length !== att.pending.length) write(ws, { ...att, pending: kept });
    }
    if (this.live().length > 0) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  private async hello(ws: WebSocket, p: Extract<ClientMessage, { type: 'hello' }>['payload']) {
    const { room } = read(ws);
    const admitted = room ? !!p.room && (await capabilityValid(p.room, room)) : !p.room;
    if (!admitted) return this.reject(ws, 'ROOM_INVALID', CLOSE_POLICY);
    const att = read(ws); // re-read: the await above may have let other events run
    if (att.left || att.peerId) return;
    const peerId = b64url(crypto.getRandomValues(new Uint8Array(16)));
    // Names are unique among visible peers; a duplicate joins hidden and is told NAME_TAKEN.
    const taken = p.discoverable && this.nameTaken(p.displayName, ws);
    const discoverable = p.discoverable && !taken;
    write(ws, { ...att, peerId, name: p.displayName, discoverable });
    this.send(ws, {
      type: 'hello-accepted',
      payload: {
        peerId,
        heartbeatSeconds: HEARTBEAT_SECONDS,
        presenceTtlSeconds: PRESENCE_TTL_SECONDS,
      },
    });
    this.send(ws, { type: 'peer-snapshot', payload: { peers: this.visiblePeers(ws) } });
    if (taken) this.error(ws, 'NAME_TAKEN');
    if (discoverable) {
      this.broadcast(ws, {
        type: 'peer-joined',
        payload: { peer: { peerId, displayName: p.displayName } },
      });
    }
  }

  private visibility(ws: WebSocket, att: Attachment, discoverable: boolean) {
    if (att.discoverable === discoverable) return;
    if (discoverable && this.nameTaken(att.name!, ws)) return this.error(ws, 'NAME_TAKEN');
    write(ws, { ...att, discoverable });
    const peerId = att.peerId!;
    this.broadcast(
      ws,
      discoverable
        ? { type: 'peer-joined', payload: { peer: { peerId, displayName: att.name! } } }
        : { type: 'peer-left', payload: { peerId } },
    );
  }

  private request(ws: WebSocket, att: Attachment, requestId: string, targetPeerId: string) {
    const target = this.find(targetPeerId);
    // Unknown, hidden and own ids look the same, so requests cannot probe for invisible peers.
    if (!target || target.ws === ws || !target.att.discoverable)
      return this.error(ws, 'PEER_NOT_FOUND');
    const now = Date.now();
    const mine = att.pending.filter((p) => p.expiresAt > now);
    const theirs = target.att.pending.filter((p) => p.expiresAt > now);
    if (mine.length >= MAX_PENDING || theirs.length >= MAX_PENDING)
      return this.error(ws, 'RATE_LIMITED');
    if (this.live().some((s) => s.att.pending.some((p) => p.id === requestId))) {
      return this.error(ws, 'REQUEST_EXPIRED');
    }
    const expiresAt = now + REQUEST_TTL_SECONDS * 1000;
    mine.push({ id: requestId, peer: targetPeerId, role: 'requester', accepted: false, expiresAt });
    theirs.push({ id: requestId, peer: att.peerId!, role: 'target', accepted: false, expiresAt });
    write(ws, { ...att, pending: mine });
    write(target.ws, { ...target.att, pending: theirs });
    this.send(target.ws, {
      type: 'connection-request',
      payload: { requestId, fromPeerId: att.peerId!, displayName: att.name!, expiresAt },
    });
  }

  private respond(ws: WebSocket, att: Attachment, requestId: string, accept: boolean) {
    const pair = this.pair(att, requestId);
    if (!pair || pair.mine.role !== 'target' || pair.mine.accepted) {
      return this.error(ws, 'REQUEST_EXPIRED');
    }
    if (accept) {
      const expiresAt = Date.now() + REQUEST_TTL_SECONDS * 1000;
      this.update(ws, requestId, (p) => ({ ...p, accepted: true, expiresAt }));
      this.update(pair.other.ws, requestId, (p) => ({ ...p, accepted: true, expiresAt }));
    } else {
      this.update(ws, requestId, () => null);
      this.update(pair.other.ws, requestId, () => null);
    }
    this.send(pair.other.ws, { type: 'connection-response', payload: { requestId, accept } });
  }

  /** Offer/answer/ICE only between the two parties of an accepted request; cancel at any time. */
  private relay(ws: WebSocket, att: Attachment, m: Relayed) {
    const { requestId } = m.payload;
    const pair = this.pair(att, requestId);
    const allowed =
      pair &&
      (m.type === 'cancel' ||
        (pair.mine.accepted &&
          (m.type === 'ice-candidate' ||
            (m.type === 'offer') === (pair.mine.role === 'requester'))));
    if (!allowed) return this.error(ws, 'REQUEST_EXPIRED');
    if (m.type === 'cancel') {
      this.update(ws, requestId, () => null);
      this.update(pair.other.ws, requestId, () => null);
    }
    this.send(pair.other.ws, m);
  }

  private leave(ws: WebSocket, closeCode?: number) {
    const att = read(ws);
    if (att.left) return;
    write(ws, { ...att, left: true });
    if (att.peerId) {
      if (att.discoverable)
        this.broadcast(ws, { type: 'peer-left', payload: { peerId: att.peerId } });
      for (const p of att.pending) {
        const other = this.find(p.peer);
        if (other?.att.pending.some((q) => q.id === p.id)) {
          this.update(other.ws, p.id, () => null);
          this.send(other.ws, { type: 'cancel', payload: { requestId: p.id } });
        }
      }
    }
    if (closeCode) {
      try {
        ws.close(closeCode, 'closed');
      } catch {
        // already closing
      }
    }
  }

  private reject(ws: WebSocket, code: ErrorCode, closeCode: number) {
    this.error(ws, code);
    this.leave(ws, closeCode);
  }

  /**
   * Compared case- and compatibility-insensitively (NFKC + lower case). Only visible peers count,
   * so the answer never reveals hidden ones.
   */
  private nameTaken(name: string, except: WebSocket): boolean {
    const key = nameKey(name);
    return this.live().some(
      (s) => s.ws !== except && s.att.peerId && s.att.discoverable && nameKey(s.att.name!) === key,
    );
  }

  private live(): Live[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, att: read(ws) }))
      .filter((s) => !s.att.left);
  }

  private find(peerId: string): Live | undefined {
    return this.live().find((s) => s.att.peerId === peerId);
  }

  private pair(att: Attachment, requestId: string) {
    const mine = att.pending.find((p) => p.id === requestId && p.expiresAt > Date.now());
    const other = mine && this.find(mine.peer);
    return other?.att.pending.some((p) => p.id === requestId) ? { mine: mine!, other } : undefined;
  }

  private update(ws: WebSocket, requestId: string, change: (p: Pending) => Pending | null) {
    const att = read(ws);
    const pending = att.pending.flatMap((p) => (p.id === requestId ? (change(p) ?? []) : [p]));
    write(ws, { ...att, pending });
  }

  private visiblePeers(except: WebSocket): Peer[] {
    return this.live()
      .filter((s) => s.ws !== except && s.att.peerId && s.att.discoverable)
      .map((s) => ({ peerId: s.att.peerId!, displayName: s.att.name! }));
  }

  private broadcast(except: WebSocket, m: ServerMessage) {
    for (const s of this.live()) if (s.ws !== except && s.att.peerId) this.send(s.ws, m);
  }

  private error(ws: WebSocket, code: ErrorCode) {
    this.send(ws, { type: 'error', payload: { code } });
  }

  private send(ws: WebSocket, m: ServerMessage) {
    try {
      ws.send(encodeMessage(m));
    } catch {
      // socket already closing; its own close event cleans up
    }
  }
}
