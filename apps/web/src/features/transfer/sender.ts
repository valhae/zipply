import { sha256, toB64url } from '../connection/sas';
import { HEADER_BYTES, encodeChunk } from './frames';

export interface SendChannel {
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  addEventListener(type: 'bufferedamountlow', fn: () => void): void;
  removeEventListener(type: 'bufferedamountlow', fn: () => void): void;
}

export interface SendOptions {
  channel: SendChannel;
  send: (frame: ArrayBuffer) => void;
  fileIdx: number;
  transferId: string;
  chunkSize: number;
  high: number;
  low: number;
  signal: AbortSignal;
}

/** Resolves once `bytes` more fit under the high watermark; rejects on abort. */
async function waitForRoom(o: SendOptions, bytes: number) {
  while (o.channel.bufferedAmount + bytes > o.high) {
    o.signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      const done = () => {
        o.channel.removeEventListener('bufferedamountlow', done);
        o.signal.removeEventListener('abort', done);
        resolve();
      };
      o.channel.addEventListener('bufferedamountlow', done);
      o.signal.addEventListener('abort', done);
    });
  }
  o.signal.throwIfAborted();
}

/**
 * Streams one file as chunk frames: bounded `File.slice` reads, per-chunk SHA-256, and backpressure
 * that keeps `bufferedAmount` at or below `high`. `o.send` is the gated send and throws outside
 * an allowed state. Returns the root: SHA-256 of the concatenated chunk digests (SD-06).
 */
export async function sendFile(file: Blob, o: SendOptions): Promise<string> {
  const frameMax = o.chunkSize + HEADER_BYTES;
  // After a bufferedamountlow event at most `low` is buffered; a frame must then fit, or we'd wait forever.
  if (o.low + frameMax > o.high) throw new Error('High watermark must exceed low + one frame');
  o.channel.bufferedAmountLowThreshold = o.low;

  const digests: Uint8Array[] = [];
  for (let offset = 0, chunkIdx = 0; offset < file.size; chunkIdx++) {
    o.signal.throwIfAborted();
    const end = Math.min(offset + o.chunkSize, file.size);
    const payload = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const digest = await sha256(payload);
    const frame = encodeChunk(
      {
        transferId: o.transferId,
        fileIdx: o.fileIdx,
        chunkIdx,
        offset,
        final: end === file.size,
        digest,
      },
      payload,
    );
    await waitForRoom(o, frame.byteLength);
    o.send(frame);
    digests.push(digest);
    offset = end;
  }
  return toB64url(await sha256(...digests));
}
