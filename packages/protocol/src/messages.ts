// Signaling message schemas v1 (P4-01). Every field is validated strictly: unknown types or keys,
// wrong types and oversized values are rejected. File metadata has no field here by design (SD-03).
import { PROTOCOL_VERSION, parseEnvelope, type EnvelopeErrorCode } from './envelope';

export const HEARTBEAT_SECONDS = 20;
export const PRESENCE_TTL_SECONDS = 60;
export const REQUEST_TTL_SECONDS = 60;
/** Heartbeats use the Durable Object auto-response pair, so they never wake the room. */
export const PING = 'ping';
export const PONG = 'pong';
export const MAX_SDP = 16 * 1024;
export const MAX_CANDIDATE = 1024;
export const MAX_PEERS = 100;

export const ERROR_CODES = [
  'INVALID_MESSAGE',
  'UNSUPPORTED_VERSION',
  'MESSAGE_TOO_LARGE',
  'PEER_NOT_FOUND',
  'REQUEST_EXPIRED',
  'RATE_LIMITED',
  'SERVER_BUSY',
  'ROOM_INVALID',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Peer {
  peerId: string;
  displayName: string;
}
export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}
type Offer = { requestId: string; connId: string; sdp: string; cO: string };
type Answer = { requestId: string; connId: string; sdp: string; nA: string };
type Ice = { requestId: string; connId: string; candidate: IceCandidate };
type Signals =
  | { type: 'offer'; payload: Offer }
  | { type: 'answer'; payload: Answer }
  | { type: 'ice-candidate'; payload: Ice }
  | { type: 'cancel'; payload: { requestId: string } }
  | { type: 'connection-response'; payload: { requestId: string; accept: boolean } };

export type ClientMessage =
  | { type: 'hello'; payload: { displayName: string; discoverable: boolean; room?: string } }
  | { type: 'visibility'; payload: { discoverable: boolean } }
  | { type: 'connection-request'; payload: { requestId: string; targetPeerId: string } }
  | Signals;

export type ServerMessage =
  | {
      type: 'hello-accepted';
      payload: { peerId: string; heartbeatSeconds: number; presenceTtlSeconds: number };
    }
  | { type: 'peer-snapshot'; payload: { peers: Peer[] } }
  | { type: 'peer-joined'; payload: { peer: Peer } }
  | { type: 'peer-left'; payload: { peerId: string } }
  | {
      type: 'connection-request';
      payload: { requestId: string; fromPeerId: string; displayName: string; expiresAt: number };
    }
  | { type: 'error'; payload: { code: ErrorCode } }
  | Signals;

export type MessageResult<M> = { ok: true; message: M } | { ok: false; code: EnvelopeErrorCode };

// ---- field checks (runtime-neutral: no atob/TextEncoder in this package) ----

type Check = (v: unknown) => boolean;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const bool: Check = (v) => typeof v === 'boolean';
const uint: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const text =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max;
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
// Canonical unpadded base64url of an exact byte length: the unused low bits of the last char are 0.
const b64 =
  (re: RegExp): Check =>
  (v) =>
    typeof v === 'string' && re.test(v);
const id16 = b64(/^[A-Za-z0-9_-]{21}[AQgw]$/);
const id20 = b64(/^[A-Za-z0-9_-]{26}[AEIMQUYcgkosw048]$/);
const id32 = b64(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

/** Strict object shape; keys ending in `?` are optional. */
const shape =
  (fields: Record<string, Check>): Check =>
  (v) => {
    if (!isObject(v)) return false;
    const spec = Object.entries(fields).map(
      ([k, c]) => [k.replace(/\?$/, ''), c, k.endsWith('?')] as const,
    );
    if (Object.keys(v).some((k) => !spec.some(([name]) => name === k))) return false;
    return spec.every(([name, check, optional]) =>
      Object.hasOwn(v, name) ? check(v[name]) : optional,
    );
  };

const BIDI = /[؜‎‏‪-‮⁦-⁩]/u;
const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /\p{Cs}/u;

/** SD-05: 1–32 code points, NFC, no surrounding whitespace, no control, bidi or lone surrogate chars. */
export function isValidDisplayName(name: string): boolean {
  const length = [...name].length;
  return (
    length >= 1 &&
    length <= 32 &&
    name === name.trim() &&
    !CONTROL.test(name) &&
    !BIDI.test(name) &&
    !LONE_SURROGATE.test(name) &&
    name === name.normalize('NFC')
  );
}
const displayName: Check = (v) => typeof v === 'string' && isValidDisplayName(v);

const candidateFields = {
  candidate: text(0, MAX_CANDIDATE),
  sdpMid: nullable(text(0, 64)),
  sdpMLineIndex: nullable((v) => uint(v) && (v as number) < 1024),
  'usernameFragment?': nullable(text(0, 256)),
};
const peer = shape({ peerId: id16, displayName });

const SIGNALS: Record<Signals['type'], Check> = {
  offer: shape({ requestId: id16, connId: id16, sdp: text(1, MAX_SDP), cO: id32 }),
  answer: shape({ requestId: id16, connId: id16, sdp: text(1, MAX_SDP), nA: id16 }),
  'ice-candidate': shape({ requestId: id16, connId: id16, candidate: shape(candidateFields) }),
  cancel: shape({ requestId: id16 }),
  'connection-response': shape({ requestId: id16, accept: bool }),
};

const CLIENT: Record<ClientMessage['type'], Check> = {
  hello: shape({ displayName, discoverable: bool, 'room?': id20 }),
  visibility: shape({ discoverable: bool }),
  'connection-request': shape({ requestId: id16, targetPeerId: id16 }),
  ...SIGNALS,
};

const SERVER: Record<ServerMessage['type'], Check> = {
  'hello-accepted': shape({ peerId: id16, heartbeatSeconds: uint, presenceTtlSeconds: uint }),
  'peer-snapshot': shape({
    peers: (v) => Array.isArray(v) && v.length <= MAX_PEERS && v.every(peer),
  }),
  'peer-joined': shape({ peer }),
  'peer-left': shape({ peerId: id16 }),
  'connection-request': shape({
    requestId: id16,
    fromPeerId: id16,
    displayName,
    expiresAt: uint,
  }),
  error: shape({ code: (v) => (ERROR_CODES as readonly unknown[]).includes(v) }),
  ...SIGNALS,
};

function parseWith<M>(schemas: Record<string, Check>, raw: string): MessageResult<M> {
  const env = parseEnvelope(raw);
  if (!env.ok) return env;
  const { type, payload, requestId } = env.envelope;
  const check = Object.hasOwn(schemas, type) ? schemas[type] : undefined;
  if (requestId !== undefined || !check?.(payload)) return { ok: false, code: 'INVALID_MESSAGE' };
  return { ok: true, message: { type, payload } as M };
}

export const parseClientMessage = (raw: string) => parseWith<ClientMessage>(CLIENT, raw);
export const parseServerMessage = (raw: string) => parseWith<ServerMessage>(SERVER, raw);

export const encodeMessage = (m: ClientMessage | ServerMessage): string =>
  JSON.stringify({ version: PROTOCOL_VERSION, type: m.type, payload: m.payload });
