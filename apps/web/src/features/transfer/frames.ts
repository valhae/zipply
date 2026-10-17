import { fromB64url, toB64url } from '../connection/sas';

export const HEADER_BYTES = 70;
export const MAX_CONTROL_BYTES = 65_536;

export interface ChunkHeader {
  transferId: string;
  fileIdx: number;
  chunkIdx: number;
  offset: number;
  final: boolean;
  digest: Uint8Array;
}
export interface FileEntry {
  name: string;
  size: number;
  type: string;
}
export type Control =
  | { v: 1; t: 'sas-reveal'; nO: string }
  | { v: 1; t: 'sas-confirm'; d: string }
  | { v: 1; t: 'manifest'; transferId: string; chunkSize: number; files: FileEntry[] }
  | { v: 1; t: 'files-accept'; transferId: string; manifestDigest: string }
  | { v: 1; t: 'files-reject'; transferId: string }
  | { v: 1; t: 'ack'; transferId: string; bytes: number }
  | { v: 1; t: 'file-end'; transferId: string; fileIdx: number; root: string }
  | { v: 1; t: 'complete'; transferId: string }
  | { v: 1; t: 'cancel' };

const VERSION = 1;
const FINAL = 0b1;
const DEFAULT_CHUNK = 65_536;
const INTEROP_MESSAGE_SIZE = 16_384; // used when maxMessageSize is unknown
export const MAX_FILES = 1000;
export const MIN_CHUNK = 1024;
export const MAX_CHUNK = 262_144;

/** Chunk payload bytes: the configured size, never more than the negotiated maxMessageSize allows. */
export function payloadSize(maxMessageSize: number | undefined, configured = DEFAULT_CHUNK) {
  const mms = maxMessageSize && maxMessageSize > 0 ? maxMessageSize : INTEROP_MESSAGE_SIZE;
  return Math.min(configured, mms - HEADER_BYTES);
}

// Layout (big-endian): ver u8 | flags u8 | transferId 16 | fileIdx u32 | chunkIdx u32 | offset u64 | len u32 | sha256 32
export function encodeChunk(h: ChunkHeader, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = h.final ? FINAL : 0;
  const id = fromB64url(h.transferId);
  if (id?.length !== 16) throw new Error('Invalid transferId');
  out.set(id, 2);
  view.setUint32(18, h.fileIdx);
  view.setUint32(22, h.chunkIdx);
  view.setBigUint64(26, BigInt(h.offset));
  view.setUint32(34, payload.length);
  out.set(h.digest, 38);
  out.set(payload, HEADER_BYTES);
  return out.buffer;
}

/** Shape-only validation; order, offsets and digests are checked by the receiver. */
export function decodeChunk(
  frame: ArrayBuffer,
  maxPayload: number,
): { header: ChunkHeader; payload: Uint8Array } | null {
  if (frame.byteLength < HEADER_BYTES) return null;
  const bytes = new Uint8Array(frame);
  const view = new DataView(frame);
  const len = view.getUint32(34);
  const offset = view.getBigUint64(26);
  if (bytes[0] !== VERSION || (bytes[1]! & ~FINAL) !== 0) return null;
  if (len !== frame.byteLength - HEADER_BYTES || len > maxPayload) return null;
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    header: {
      transferId: toB64url(bytes.subarray(2, 18)),
      fileIdx: view.getUint32(18),
      chunkIdx: view.getUint32(22),
      offset: Number(offset),
      final: bytes[1] === FINAL,
      digest: bytes.slice(38, HEADER_BYTES),
    },
    payload: bytes.subarray(HEADER_BYTES),
  };
}

type Check = (value: unknown) => boolean;
const b64 =
  (n: number): Check =>
  (v) =>
    typeof v === 'string' && fromB64url(v)?.length === n;
const uint: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const text =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const exact =
  (shape: Record<string, Check>): Check =>
  (v) =>
    isObject(v) &&
    Object.keys(v).length === Object.keys(shape).length &&
    Object.entries(shape).every(([k, check]) => Object.hasOwn(v, k) && check(v[k]));

const fileEntry = exact({ name: text(1, 1024), size: uint, type: text(0, 255) });
const files: Check = (v) =>
  Array.isArray(v) &&
  v.length >= 1 &&
  v.length <= MAX_FILES &&
  v.every(fileEntry) &&
  Number.isSafeInteger(v.reduce((n: number, f: FileEntry) => n + f.size, 0));

const SCHEMAS: Record<Control['t'], Record<string, Check>> = {
  'sas-reveal': { nO: b64(16) },
  'sas-confirm': { d: b64(32) },
  manifest: {
    transferId: b64(16),
    chunkSize: (v) => uint(v) && (v as number) >= MIN_CHUNK && (v as number) <= MAX_CHUNK,
    files,
  },
  'files-accept': { transferId: b64(16), manifestDigest: b64(32) },
  'files-reject': { transferId: b64(16) },
  ack: { transferId: b64(16), bytes: uint },
  'file-end': { transferId: b64(16), fileIdx: uint, root: b64(32) },
  complete: { transferId: b64(16) },
  cancel: {},
};

/** Strictly parses one DataChannel control message; null for anything malformed or unknown. */
export function parseControl(raw: string): Control | null {
  if (raw.length > MAX_CONTROL_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data) || data.v !== VERSION || typeof data.t !== 'string') return null;
  const schema = Object.hasOwn(SCHEMAS, data.t) ? SCHEMAS[data.t as Control['t']] : null;
  if (!schema) return null;
  return exact({ v: () => true, t: () => true, ...schema })(data) ? (data as Control) : null;
}
