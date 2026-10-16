// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  HEADER_BYTES,
  MAX_CONTROL_BYTES,
  decodeChunk,
  encodeChunk,
  parseControl,
  payloadSize,
  type ChunkHeader,
} from './frames';

const ID = 'AAECAwQFBgcICQoLDA0ODw'; // 16 bytes
const D32 = 'A'.repeat(42) + 'A'; // 32 zero bytes
const header = (over: Partial<ChunkHeader> = {}): ChunkHeader => ({
  transferId: ID,
  fileIdx: 2,
  chunkIdx: 7,
  offset: 7 * 65_536,
  final: true,
  digest: new Uint8Array(32).fill(9),
  ...over,
});

describe('payloadSize', () => {
  it.each([
    [262_144, 65_536],
    [65_536, 65_536 - HEADER_BYTES],
    [1_073_741_823, 65_536],
    [Infinity, 65_536],
    [undefined, 16_384 - HEADER_BYTES], // unknown → conservative interop size
    [0, 16_384 - HEADER_BYTES],
  ])('maxMessageSize %s → %s', (mms, expected) => {
    expect(payloadSize(mms)).toBe(expected);
  });
});

describe('chunk frames', () => {
  it('round-trips header and payload', () => {
    const payload = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    const frame = encodeChunk(header({ offset: 2 ** 40 }), payload);
    expect(frame.byteLength).toBe(HEADER_BYTES + 300);
    const decoded = decodeChunk(frame, 65_536);
    expect(decoded?.header).toEqual(header({ offset: 2 ** 40 }));
    expect(decoded?.payload).toEqual(payload);
  });

  it('accepts an empty payload', () => {
    expect(decodeChunk(encodeChunk(header(), new Uint8Array()), 1024)?.payload.length).toBe(0);
  });

  const valid = () => new Uint8Array(encodeChunk(header(), new Uint8Array(10)));
  it.each<[string, (b: Uint8Array<ArrayBuffer>) => ArrayBuffer]>([
    ['too short for a header', (b) => b.slice(0, HEADER_BYTES - 1).buffer],
    ['unknown version', (b) => ((b[0] = 2), b.buffer)],
    ['unknown flag bits', (b) => ((b[1] = 0b10), b.buffer)],
    ['declared length ≠ payload length', (b) => b.slice(0, b.length - 1).buffer],
    ['offset beyond 2^53', (b) => (new DataView(b.buffer).setBigUint64(26, 2n ** 53n), b.buffer)],
  ])('rejects %s', (_, mutate) => {
    expect(decodeChunk(mutate(valid()), 65_536)).toBeNull();
  });

  it('rejects a payload larger than the agreed chunk size', () => {
    const frame = encodeChunk(header(), new Uint8Array(1025));
    expect(decodeChunk(frame, 1024)).toBeNull();
    expect(decodeChunk(frame, 1025)).not.toBeNull();
  });
});

describe('parseControl', () => {
  const ok = [
    { v: 1, t: 'sas-reveal', nO: ID },
    { v: 1, t: 'sas-confirm', d: D32 },
    {
      v: 1,
      t: 'manifest',
      transferId: ID,
      chunkSize: 65_536,
      files: [{ name: 'a.txt', size: 0, type: '' }],
    },
    { v: 1, t: 'files-accept', transferId: ID, manifestDigest: D32 },
    { v: 1, t: 'files-reject', transferId: ID },
    { v: 1, t: 'ack', transferId: ID, bytes: 10 },
    { v: 1, t: 'file-end', transferId: ID, fileIdx: 0, root: D32 },
    { v: 1, t: 'complete', transferId: ID },
    { v: 1, t: 'cancel' },
  ];

  it.each(ok)('accepts $t', (msg) => {
    expect(parseControl(JSON.stringify(msg))).toEqual(msg);
  });

  const manifest = (over: object) =>
    JSON.stringify({ v: 1, t: 'manifest', transferId: ID, chunkSize: 65_536, files: [], ...over });
  const file = { name: 'a', size: 1, type: 'text/plain' };

  it.each([
    ['invalid JSON', '{'],
    ['array', '[]'],
    ['wrong version', JSON.stringify({ v: 2, t: 'cancel' })],
    ['unknown type', JSON.stringify({ v: 1, t: 'verified' })],
    ['extra field', JSON.stringify({ v: 1, t: 'cancel', verified: true })],
    ['missing field', JSON.stringify({ v: 1, t: 'sas-confirm' })],
    ['short nonce', JSON.stringify({ v: 1, t: 'sas-reveal', nO: 'AAEC' })],
    [
      'non-canonical base64url',
      JSON.stringify({ v: 1, t: 'sas-reveal', nO: ID.slice(0, -1) + 'x' }),
    ],
    ['negative ack', JSON.stringify({ v: 1, t: 'ack', transferId: ID, bytes: -1 })],
    ['fractional ack', JSON.stringify({ v: 1, t: 'ack', transferId: ID, bytes: 1.5 })],
    ['oversize text', JSON.stringify({ v: 1, t: 'cancel', pad: 'x'.repeat(MAX_CONTROL_BYTES) })],
    ['empty file list', manifest({})],
    ['tiny chunk size', manifest({ files: [file], chunkSize: 512 })],
    ['huge chunk size', manifest({ files: [file], chunkSize: 262_145 })],
    ['empty file name', manifest({ files: [{ ...file, name: '' }] })],
    ['negative size', manifest({ files: [{ ...file, size: -1 }] })],
    ['unsafe size', manifest({ files: [{ ...file, size: 2 ** 53 }] })],
    ['extra file field', manifest({ files: [{ ...file, path: '/etc' }] })],
    ['too many files', manifest({ files: Array(1001).fill(file) })],
    [
      'total over 2^53',
      manifest({
        files: [
          { ...file, size: 2 ** 52 },
          { ...file, size: 2 ** 52 },
        ],
      }),
    ],
  ])('rejects %s', (_, text) => {
    expect(parseControl(text)).toBeNull();
  });
});

// Randomized property checks (fast-check arrives with P4-01).
describe('frame properties', () => {
  it('random headers round-trip exactly (500 runs)', () => {
    for (let run = 0; run < 500; run++) {
      const r = (max: number) => Math.floor(Math.random() * max);
      const h: ChunkHeader = {
        transferId: ID,
        fileIdx: r(2 ** 32),
        chunkIdx: r(2 ** 32),
        offset: r(Number.MAX_SAFE_INTEGER),
        final: Math.random() < 0.5,
        digest: crypto.getRandomValues(new Uint8Array(32)),
      };
      const payload = crypto.getRandomValues(new Uint8Array(r(2048)));
      expect(decodeChunk(encodeChunk(h, payload), 2048)).toEqual({ header: h, payload });
    }
  });

  it('random corruption never throws: decode returns null or a well-formed frame (2,000 runs)', () => {
    const frame = new Uint8Array(encodeChunk(header(), new Uint8Array(100)));
    for (let run = 0; run < 2000; run++) {
      const mutated = frame.slice(0, 1 + Math.floor(Math.random() * frame.length));
      for (let k = 0; k < 3; k++) mutated[Math.floor(Math.random() * mutated.length)]! ^= 0xff;
      const decoded = decodeChunk(mutated.buffer, 65_536);
      if (decoded) expect(decoded.payload.length).toBe(mutated.length - HEADER_BYTES);
    }
  });

  it('random JSON never throws in parseControl (2,000 runs)', () => {
    const values = [null, true, 1, -1, 1.5, 'x', '', [], {}, ID, D32, 2 ** 53];
    const keys = ['v', 't', 'nO', 'd', 'transferId', 'files', 'bytes', 'chunkSize', 'extra'];
    const types = ['cancel', 'ack', 'manifest', 'sas-reveal', 'nope'];
    for (let run = 0; run < 2000; run++) {
      const pick = <T>(l: T[]) => l[Math.floor(Math.random() * l.length)]!;
      const msg: Record<string, unknown> = { v: 1, t: pick(types) };
      for (let k = 0; k < 3; k++) msg[pick(keys)] = pick(values);
      expect(() => parseControl(JSON.stringify(msg))).not.toThrow();
    }
  });
});
