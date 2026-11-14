import { sha256, toB64url } from '../connection/sas';
import { decodeChunk, type FileEntry } from './frames';
import { memorySink, type Sink } from './sinks';

export const ACK_EVERY = 1024 * 1024;
export const DEFAULT_RECEIVE_CAP = 256 * 1024 * 1024;

export interface Manifest {
  transferId: string;
  chunkSize: number;
  files: FileEntry[];
}

export type Failure = 'protocol' | 'integrity' | 'storage';
export type ReceiveResult = { ok: true; ack: boolean } | { ok: false; reason: Failure };

export const exceedsCap = (m: Manifest, cap: number) =>
  m.files.reduce((n, f) => n + f.size, 0) > cap;

const READ_BACK_BYTES = 4 * 1024 * 1024;
const bad = (reason: Failure): ReceiveResult => ({ ok: false, reason });
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** SD-06 read-back: the committed file must have the declared size and every chunk's digest. */
async function readBack(stored: Blob, digests: Uint8Array[], chunk: number, size: number) {
  if (stored.size !== size || digests.length !== Math.ceil(size / chunk)) return false;
  const step = Math.max(1, Math.floor(READ_BACK_BYTES / chunk)) * chunk;
  for (let start = 0, i = 0; start < size; start += step) {
    const bytes = new Uint8Array(await stored.slice(start, start + step).arrayBuffer());
    for (let o = 0; o < bytes.length; o += chunk, i++) {
      if (!equal(await sha256(bytes.subarray(o, o + chunk)), digests[i]!)) return false;
    }
  }
  return true;
}

/**
 * Receives one manifest into a sink. Every chunk must be the next expected one, with the exact
 * expected length and a matching SHA-256, before it is written; a repeat of a verified chunk is
 * acknowledged without writing (SD-07); anything else fails. A file counts only after its root
 * matches and the committed copy reads back intact. Calls must be serialized by the caller.
 */
export function createReceiver(m: Manifest, sink: Sink = memorySink(), ackEvery = ACK_EVERY) {
  let fileIdx = 0;
  let received = 0; // verified, written bytes of the current file
  let confirmed = 0; // verified, written bytes across all files
  let lastAck = 0;
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
      if (h.transferId !== m.transferId || h.fileIdx !== fileIdx) return bad('protocol');
      const offset = h.chunkIdx < digests.length ? h.chunkIdx * m.chunkSize : received;
      const expectedLen = Math.min(m.chunkSize, file.size - offset);
      if (
        h.chunkIdx > digests.length ||
        h.offset !== offset ||
        expectedLen <= 0 ||
        payload.length !== expectedLen ||
        h.final !== (offset + expectedLen === file.size)
      ) {
        return bad('protocol');
      }
      if (!equal(await sha256(payload), h.digest)) return bad('integrity');
      if (h.chunkIdx < digests.length) {
        return equal(h.digest, digests[h.chunkIdx]!) ? { ok: true, ack: false } : bad('integrity');
      }
      try {
        await sink.write(fileIdx, received, payload);
      } catch {
        return bad('storage');
      }
      digests.push(h.digest);
      received += payload.length;
      confirmed += payload.length;
      const ack = confirmed - lastAck >= ackEvery;
      if (ack) lastAck = confirmed;
      return { ok: true, ack };
    },

    async fileEnd(idx: number, root: string): Promise<ReceiveResult> {
      const file = m.files[fileIdx];
      if (!file || idx !== fileIdx || received !== file.size) return bad('protocol');
      if (toB64url(await sha256(...digests)) !== root) return bad('integrity');
      let stored: Blob;
      try {
        stored = await sink.close(fileIdx);
        if (!(await readBack(stored, digests, m.chunkSize, file.size))) return bad('integrity');
      } catch {
        return bad('storage');
      }
      blobs.push(stored);
      digests = [];
      received = 0;
      fileIdx++;
      lastAck = confirmed;
      return { ok: true, ack: true };
    },

    /** Resume: drops any unconfirmed tail and returns where the sender must continue. */
    async rewind() {
      if (fileIdx < m.files.length) await sink.truncate(fileIdx, received);
      return { fileIdx, offset: received };
    },

    abort: () => sink.abort(),
  };
}
