import { sha256, toB64url } from '../connection/sas';
import { decodeChunk, type FileEntry } from './frames';

export const ACK_EVERY = 1024 * 1024;
export const DEFAULT_RECEIVE_CAP = 256 * 1024 * 1024;

export interface Manifest {
  transferId: string;
  chunkSize: number;
  files: FileEntry[];
}

export type ReceiveResult =
  { ok: true; ack: boolean } | { ok: false; reason: 'protocol' | 'integrity' };

export const exceedsCap = (m: Manifest, cap: number) =>
  m.files.reduce((n, f) => n + f.size, 0) > cap;

const bad = (reason: 'protocol' | 'integrity'): ReceiveResult => ({ ok: false, reason });
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Memory sink for one manifest (P3; large files move to disk sinks in P6). Every chunk must be the
 * next expected one, with the exact expected length and a matching SHA-256; anything else fails.
 * Calls must be serialized by the caller (each awaits a digest).
 */
export function createReceiver(m: Manifest) {
  let fileIdx = 0;
  let received = 0; // bytes of the current file
  let confirmed = 0; // verified bytes across all files
  let lastAck = 0;
  let parts: Uint8Array[] = [];
  let digests: Uint8Array[] = [];
  const blobs: Blob[] = [];

  return {
    get done() {
      return fileIdx === m.files.length;
    },
    get confirmed() {
      return confirmed;
    },
    blobs: blobs as readonly Blob[],

    async chunk(frame: ArrayBuffer): Promise<ReceiveResult> {
      const decoded = decodeChunk(frame, m.chunkSize);
      const file = m.files[fileIdx];
      if (!decoded || !file) return bad('protocol');
      const { header: h, payload } = decoded;
      const expectedLen = Math.min(m.chunkSize, file.size - received);
      if (
        h.transferId !== m.transferId ||
        h.fileIdx !== fileIdx ||
        h.chunkIdx !== parts.length ||
        h.offset !== received ||
        expectedLen <= 0 ||
        payload.length !== expectedLen ||
        h.final !== (received + expectedLen === file.size)
      ) {
        return bad('protocol');
      }
      if (!equal(await sha256(payload), h.digest)) return bad('integrity');
      parts.push(payload);
      digests.push(h.digest);
      received += payload.length;
      confirmed += payload.length;
      const ack = confirmed - lastAck >= ACK_EVERY;
      if (ack) lastAck = confirmed;
      return { ok: true, ack };
    },

    async fileEnd(idx: number, root: string): Promise<ReceiveResult> {
      const file = m.files[fileIdx];
      if (!file || idx !== fileIdx || received !== file.size) return bad('protocol');
      if (toB64url(await sha256(...digests)) !== root) return bad('integrity');
      // Inert download: never the sender's MIME type, so nothing renders or runs in our origin.
      blobs.push(new Blob(parts as BlobPart[], { type: 'application/octet-stream' }));
      parts = [];
      digests = [];
      received = 0;
      fileIdx++;
      lastAck = confirmed;
      return { ok: true, ack: true };
    },
  };
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name safe to show and to suggest for download: no paths, controls, bidi tricks or device names. */
export function safeFilename(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const short = [...cleaned].slice(0, 200).join('');
  if (!short) return 'file';
  return RESERVED.test(short) ? `_${short}` : short;
}
