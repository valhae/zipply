// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sha256, toB64url } from '../connection/sas';
import { encodeChunk, type ChunkHeader } from './frames';
import { ACK_EVERY, createReceiver, type Manifest } from './receiver';
import { memorySink, type Sink } from './sinks';

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const CHUNK = 1024;
const random = (n: number) => Uint8Array.from({ length: n }, () => (Math.random() * 256) | 0);
const manifest = (...sizes: number[]): Manifest => ({
  transferId: ID,
  chunkSize: CHUNK,
  files: sizes.map((size, i) => ({ name: `f${i}.bin`, size, type: '' })),
});

async function chunksOf(data: Uint8Array, fileIdx: number) {
  const frames: { header: ChunkHeader; payload: Uint8Array }[] = [];
  for (let offset = 0, chunkIdx = 0; offset < data.length; chunkIdx++, offset += CHUNK) {
    const payload = data.subarray(offset, offset + CHUNK);
    const final = offset + payload.length === data.length;
    frames.push({
      header: { transferId: ID, fileIdx, chunkIdx, offset, final, digest: await sha256(payload) },
      payload,
    });
  }
  const root = toB64url(await sha256(...frames.map((f) => f.header.digest)));
  return { frames, root, encoded: frames.map((f) => encodeChunk(f.header, f.payload)) };
}

describe('receiver: valid transfers', () => {
  it('reassembles several files byte-exact as inert blobs', async () => {
    const files = [random(0), random(1), random(CHUNK), random(CHUNK + 1), random(5 * CHUNK + 9)];
    const r = createReceiver(manifest(...files.map((f) => f.length)));
    for (const [i, data] of files.entries()) {
      const { encoded, root } = await chunksOf(data, i);
      for (const frame of encoded) expect(await r.chunk(frame)).toMatchObject({ ok: true });
      expect(await r.fileEnd(i, root)).toMatchObject({ ok: true, ack: true });
    }
    expect(r.done).toBe(true);
    expect(r.confirmed).toBe(files.reduce((n, f) => n + f.length, 0));
    for (const [i, blob] of r.blobs.entries()) {
      expect(blob.type).toBe('application/octet-stream');
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files[i]);
    }
  });

  it('asks for a cumulative ack every ACK_EVERY bytes', async () => {
    const data = random(ACK_EVERY + 3 * CHUNK);
    const r = createReceiver(manifest(data.length));
    const { encoded } = await chunksOf(data, 0);
    const acks: number[] = [];
    for (const frame of encoded) {
      const result = await r.chunk(frame);
      if (result.ok && result.ack) acks.push(r.confirmed);
    }
    expect(acks).toEqual([ACK_EVERY]);
  });
});

describe('receiver: rejects malformed or out-of-order input', () => {
  const setup = async (size = 3 * CHUNK) => {
    const data = random(size);
    const parts = await chunksOf(data, 0);
    return { r: createReceiver(manifest(size, 10)), ...parts };
  };
  const tamper = (
    f: { header: ChunkHeader; payload: Uint8Array },
    h: Partial<ChunkHeader>,
    p = f.payload,
  ) => encodeChunk({ ...f.header, ...h }, p);

  it.each<[string, (s: Awaited<ReturnType<typeof setup>>) => ArrayBuffer]>([
    ['skipped chunk', (s) => s.encoded[1]!],
    ['wrong transfer id', (s) => tamper(s.frames[0]!, { transferId: 'AQECAwQFBgcICQoLDA0ODw' })],
    ['wrong file index', (s) => tamper(s.frames[0]!, { fileIdx: 1 })],
    ['wrong offset', (s) => tamper(s.frames[0]!, { offset: 1 })],
    ['final flag on a middle chunk', (s) => tamper(s.frames[0]!, { final: true })],
    ['short non-final chunk', (s) => tamper(s.frames[0]!, {}, s.frames[0]!.payload.subarray(1))],
    ['payload larger than the chunk size', (s) => tamper(s.frames[0]!, {}, random(CHUNK + 1))],
    ['garbage frame', () => new Uint8Array(5).buffer],
  ])('%s → protocol violation', async (_, make) => {
    const s = await setup();
    expect(await s.r.chunk(make(s))).toEqual({ ok: false, reason: 'protocol' });
  });

  it('digest mismatch → integrity failure', async () => {
    const s = await setup();
    const f = s.frames[0]!;
    const flipped = f.payload.slice();
    flipped[0]! ^= 1;
    expect(await s.r.chunk(encodeChunk(f.header, flipped))).toEqual({
      ok: false,
      reason: 'integrity',
    });
  });

  it('duplicate chunk with the same digest is acknowledged without rewriting (SD-07)', async () => {
    const s = await setup();
    await s.r.chunk(s.encoded[0]!);
    await s.r.chunk(s.encoded[1]!);
    expect(await s.r.chunk(s.encoded[0]!)).toEqual({ ok: true, ack: false });
    expect(s.r.confirmed).toBe(2 * CHUNK);
    await s.r.chunk(s.encoded[2]!);
    expect(await s.r.fileEnd(0, s.root)).toMatchObject({ ok: true });
    expect(new Uint8Array(await s.r.blobs[0]!.arrayBuffer())).toEqual(
      new Uint8Array(s.frames.flatMap((f) => [...f.payload])),
    );
  });

  it('duplicate chunk with a different digest → integrity failure', async () => {
    const s = await setup();
    await s.r.chunk(s.encoded[0]!);
    await s.r.chunk(s.encoded[1]!);
    const other = random(CHUNK);
    const forged = encodeChunk({ ...s.frames[0]!.header, digest: await sha256(other) }, other);
    expect(await s.r.chunk(forged)).toEqual({ ok: false, reason: 'integrity' });
  });

  it('a chunk before the next expected one at another offset → protocol violation', async () => {
    const s = await setup();
    await s.r.chunk(s.encoded[0]!);
    await s.r.chunk(s.encoded[1]!);
    expect(await s.r.chunk(tamper(s.frames[0]!, { offset: 5 }))).toEqual({
      ok: false,
      reason: 'protocol',
    });
  });

  it('bytes beyond the declared size → protocol violation', async () => {
    const s = await setup(CHUNK);
    await s.r.chunk(s.encoded[0]!);
    expect(await s.r.chunk(tamper(s.frames[0]!, { chunkIdx: 1, offset: CHUNK }))).toEqual({
      ok: false,
      reason: 'protocol',
    });
  });

  it('file end before all bytes → protocol violation', async () => {
    const s = await setup();
    await s.r.chunk(s.encoded[0]!);
    expect(await s.r.fileEnd(0, s.root)).toEqual({ ok: false, reason: 'protocol' });
  });

  it('file end with a different root → integrity failure', async () => {
    const s = await setup();
    for (const f of s.encoded) await s.r.chunk(f);
    expect(await s.r.fileEnd(0, toB64url(new Uint8Array(32)))).toEqual({
      ok: false,
      reason: 'integrity',
    });
  });

  it('file end for the wrong file, or after the last file → protocol violation', async () => {
    const s = await setup();
    for (const f of s.encoded) await s.r.chunk(f);
    expect(await s.r.fileEnd(1, s.root)).toEqual({ ok: false, reason: 'protocol' });
    const one = createReceiver(manifest(0));
    expect(await one.fileEnd(0, toB64url(await sha256()))).toMatchObject({ ok: true });
    expect(await one.fileEnd(0, toB64url(await sha256()))).toEqual({
      ok: false,
      reason: 'protocol',
    });
  });

  it('chunk for the next file before the current one ends → protocol violation', async () => {
    const s = await setup();
    for (const f of s.encoded) await s.r.chunk(f);
    const next = await chunksOf(random(10), 1);
    expect(await s.r.chunk(next.encoded[0]!)).toEqual({ ok: false, reason: 'protocol' });
  });
});

/** Memory sink with hooks to corrupt or fail writes, for fault injection. */
function faultySink(fault: { flip?: number; failAt?: number } = {}) {
  const inner = memorySink();
  let written = 0;
  const truncates: [number, number][] = [];
  const sink: Sink = {
    ...inner,
    async write(fileIdx, offset, data) {
      if (fault.failAt !== undefined && written + data.length > fault.failAt) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      const copy = data.slice();
      if (fault.flip !== undefined && fault.flip >= written && fault.flip < written + data.length) {
        copy[fault.flip - written]! ^= 1;
      }
      written += data.length;
      return inner.write(fileIdx, offset, copy);
    },
    truncate(fileIdx, size) {
      truncates.push([fileIdx, size]);
      return inner.truncate(fileIdx, size);
    },
  };
  return { sink, truncates };
}

describe('receiver: sink and read-back (P6-01, P6-02)', () => {
  it('a byte flipped by the sink fails the read-back and is never offered', async () => {
    const data = random(3 * CHUNK + 5);
    const { sink } = faultySink({ flip: CHUNK + 7 });
    const r = createReceiver(manifest(data.length), sink);
    const { encoded, root } = await chunksOf(data, 0);
    for (const f of encoded) expect(await r.chunk(f)).toMatchObject({ ok: true });
    expect(await r.fileEnd(0, root)).toEqual({ ok: false, reason: 'integrity' });
    expect(r.blobs).toHaveLength(0);
    expect(r.done).toBe(false);
  });

  it('a stored file of the wrong size fails the read-back', async () => {
    const data = random(2 * CHUNK);
    const inner = memorySink();
    const sink: Sink = { ...inner, close: async () => new Blob([data.subarray(0, CHUNK)]) };
    const r = createReceiver(manifest(data.length), sink);
    const { encoded, root } = await chunksOf(data, 0);
    for (const f of encoded) await r.chunk(f);
    expect(await r.fileEnd(0, root)).toEqual({ ok: false, reason: 'integrity' });
  });

  it('a failed write stops with a storage failure and confirms nothing more', async () => {
    const data = random(4 * CHUNK);
    const { sink } = faultySink({ failAt: 2 * CHUNK + 1 });
    const r = createReceiver(manifest(data.length), sink);
    const { encoded } = await chunksOf(data, 0);
    expect(await r.chunk(encoded[0]!)).toMatchObject({ ok: true });
    expect(await r.chunk(encoded[1]!)).toMatchObject({ ok: true });
    expect(await r.chunk(encoded[2]!)).toEqual({ ok: false, reason: 'storage' });
    expect(r.confirmed).toBe(2 * CHUNK);
  });

  it('acks at a configurable checkpoint interval', async () => {
    const data = random(10 * CHUNK);
    const r = createReceiver(manifest(data.length), memorySink(), 3 * CHUNK);
    const acks: number[] = [];
    for (const f of (await chunksOf(data, 0)).encoded) {
      const result = await r.chunk(f);
      if (result.ok && result.ack) acks.push(r.confirmed);
    }
    expect(acks).toEqual([3 * CHUNK, 6 * CHUNK, 9 * CHUNK]);
  });
});

describe('receiver: resume (P6-03, P6-05)', () => {
  it('rewind truncates the unconfirmed tail and continues byte-exact from there', async () => {
    const files = [random(2 * CHUNK + 3), random(5 * CHUNK + 1)];
    const { sink, truncates } = faultySink();
    const r = createReceiver(manifest(...files.map((f) => f.length)), sink);
    const first = await chunksOf(files[0]!, 0);
    for (const f of first.encoded) await r.chunk(f);
    await r.fileEnd(0, first.root);
    const second = await chunksOf(files[1]!, 1);
    for (const f of second.encoded.slice(0, 3)) await r.chunk(f);

    expect(await r.rewind()).toEqual({ fileIdx: 1, offset: 3 * CHUNK });
    expect(truncates).toEqual([[1, 3 * CHUNK]]);
    for (const f of second.encoded.slice(3)) expect(await r.chunk(f)).toMatchObject({ ok: true });
    expect(await r.fileEnd(1, second.root)).toMatchObject({ ok: true });
    expect(r.done).toBe(true);
    for (const [i, blob] of r.blobs.entries()) {
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files[i]);
    }
  });

  it('rewind at a file boundary points at the next file', async () => {
    const data = random(CHUNK);
    const r = createReceiver(manifest(data.length, 10));
    const { encoded, root } = await chunksOf(data, 0);
    await r.chunk(encoded[0]!);
    await r.fileEnd(0, root);
    expect(await r.rewind()).toEqual({ fileIdx: 1, offset: 0 });
  });
});
