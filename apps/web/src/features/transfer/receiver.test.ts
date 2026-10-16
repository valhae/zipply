// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sha256, toB64url } from '../connection/sas';
import { encodeChunk, type ChunkHeader } from './frames';
import { ACK_EVERY, createReceiver, exceedsCap, safeFilename, type Manifest } from './receiver';

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

  it('duplicate chunk → protocol violation', async () => {
    const s = await setup();
    await s.r.chunk(s.encoded[0]!);
    expect(await s.r.chunk(s.encoded[0]!)).toEqual({ ok: false, reason: 'protocol' });
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

describe('exceedsCap', () => {
  it('compares the manifest total with the cap', () => {
    expect(exceedsCap(manifest(100, 28), 128)).toBe(false);
    expect(exceedsCap(manifest(100, 29), 128)).toBe(true);
  });
});

describe('safeFilename', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['C:\\Windows\\evil.exe', 'C__Windows_evil.exe'],
    ['a<b>c:d"e|f?g*h', 'a_b_c_d_e_f_g_h'],
    ['photo\u202Egnp.exe', 'photognp.exe'],
    ['bell\u0007\nname.txt', 'bellname.txt'],
    ['  .hidden. ', 'hidden'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['', 'file'],
    ['...', 'file'],
    ['Bücher 📚.txt', 'Bücher 📚.txt'],
  ])('%j → %j', (input, expected) => {
    expect(safeFilename(input)).toBe(expected);
  });

  it('limits length to 200 code points', () => {
    expect([...safeFilename('x'.repeat(500))]).toHaveLength(200);
  });
});
