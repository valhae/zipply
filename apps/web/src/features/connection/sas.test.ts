// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  commit,
  fromB64url,
  parseFingerprints,
  phrase,
  sasDigest,
  toB64url,
  type SasInputs,
} from './sas';
import { WORDLIST } from './wordlist';

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const FP_O = 'AA:'.repeat(31) + 'AA';
const FP_A = '0b:'.repeat(31) + '0b';
const sdp = (...fps: string[]) =>
  [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    ...fps.map((f) => `a=fingerprint:${f}`),
    'm=application',
  ].join('\r\n');

const inputs = (): SasInputs => ({
  connId: bytes(16, 1),
  cO: bytes(32, 2),
  nO: bytes(16, 3),
  nA: bytes(16, 4),
  fpO: [bytes(32, 0xaa)],
  fpA: [bytes(32, 0x0b)],
});

// Independent construction of the SD-02 transcript, used to check the implementation.
async function expectedDigest(i: SasInputs) {
  const enc = new TextEncoder();
  const lp = (b: Uint8Array) => {
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length);
    out.set(b, 4);
    return out;
  };
  const cat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const t = cat([
    lp(enc.encode('zipply/sas/v1')),
    lp(new Uint8Array([1])),
    lp(i.connId),
    lp(cat(i.fpO)),
    lp(cat(i.fpA)),
    lp(i.cO),
    lp(i.nO),
    lp(i.nA),
  ]);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', t));
}

describe('wordlist', () => {
  it('has 2,048 unique words', () => {
    expect(WORDLIST).toHaveLength(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect([WORDLIST[0], WORDLIST[2047]]).toEqual(['abandon', 'zoo']);
  });
});

describe('base64url', () => {
  it('round-trips and rejects non-canonical input', () => {
    const b = new Uint8Array([0, 251, 255, 1]);
    expect(toB64url(b)).toBe('APv_AQ');
    expect(fromB64url('APv_AQ')).toEqual(b);
    expect(fromB64url('AP+/AQ')).toBeNull();
    expect(fromB64url('APv_AQ==')).toBeNull();
    expect(fromB64url('APv_AR')).toBeNull(); // non-zero padding bits
    expect(fromB64url('A')).toBeNull();
  });
});

describe('parseFingerprints', () => {
  it('normalizes, deduplicates and sorts sha-256 fingerprints, ignoring other hashes', () => {
    const fps = parseFingerprints(
      sdp(`sha-256 ${FP_O}`, `sha-256 ${FP_A}`, `sha-256 ${FP_A.toUpperCase()}`, 'sha-1 AB:CD'),
    );
    expect(fps).toEqual([bytes(32, 0x0b), bytes(32, 0xaa)]);
  });

  it.each([
    ['no fingerprint', sdp()],
    ['only sha-1', sdp('sha-1 ' + 'AB:'.repeat(19) + 'AB')],
    ['short sha-256', sdp('sha-256 AB:CD')],
    ['non-hex sha-256', sdp('sha-256 ' + 'ZZ:'.repeat(31) + 'ZZ')],
    ['one bad among good', sdp(`sha-256 ${FP_O}`, 'sha-256 AB')],
  ])('fails closed on %s', (_, input) => {
    expect(parseFingerprints(input)).toBeNull();
  });
});

describe('commit', () => {
  it('is SHA-256 of the label, connId and nO, and changes with any input', async () => {
    const enc = new TextEncoder().encode('zipply/sas-commit/v1');
    const manual = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new Uint8Array([...enc, ...bytes(16, 1), ...bytes(16, 3)]),
      ),
    );
    expect(await commit(bytes(16, 1), bytes(16, 3))).toEqual(manual);
    expect(await commit(bytes(16, 1), bytes(16, 4))).not.toEqual(manual);
    expect(await commit(bytes(16, 2), bytes(16, 3))).not.toEqual(manual);
  });
});

describe('sasDigest', () => {
  it('matches the independently built SD-02 transcript (test vector)', async () => {
    const i = inputs();
    const d = await sasDigest(i);
    expect(d).toEqual(await expectedDigest(i));
    expect(toB64url(d)).toMatchInlineSnapshot(`"T0NpDwLWVtF8uut_eIa3nf-xW63IK8l4M38X9xolkGE"`);
  });

  it.each(['connId', 'cO', 'nO', 'nA'] as const)('changes when %s changes', async (key) => {
    const base = await sasDigest(inputs());
    const i = inputs();
    i[key] = i[key].map((x) => x ^ 1);
    expect(await sasDigest(i)).not.toEqual(base);
  });

  it('is bound to role order: swapping fingerprints changes it', async () => {
    const i = inputs();
    expect(await sasDigest({ ...i, fpO: i.fpA, fpA: i.fpO })).not.toEqual(await sasDigest(i));
  });

  it('rejects wrong-length nonces and empty fingerprint lists', async () => {
    await expect(sasDigest({ ...inputs(), nO: bytes(15, 3) })).rejects.toThrow();
    await expect(sasDigest({ ...inputs(), fpA: [] })).rejects.toThrow();
  });
});

describe('phrase', () => {
  it('maps the first 66 bits to six 11-bit word indices', () => {
    expect(phrase(bytes(32, 0))).toEqual(Array(6).fill('abandon'));
    expect(phrase(bytes(32, 0xff))).toEqual(Array(6).fill('zoo'));
    // Indices 1..6 as 11-bit fields: 00000000001 00000000010 … 00000000110, packed into bytes.
    const d = bytes(32, 0);
    d.set([0x00, 0x20, 0x08, 0x01, 0x80, 0x40, 0x0a, 0x01, 0x80]);
    expect(phrase(d)).toEqual([1, 2, 3, 4, 5, 6].map((n) => WORDLIST[n]));
  });

  it('ignores bits after the 66th', () => {
    const d = bytes(32, 0);
    d[8] = 0x3f; // bits 66..71
    d[31] = 0xff;
    expect(phrase(d)).toEqual(Array(6).fill('abandon'));
  });
});

// Randomized property checks (fast-check arrives with P4-01; plain loops suffice here).
describe('properties', () => {
  const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  const hex = (b: Uint8Array, lower: boolean) => {
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
    return lower ? h : h.toUpperCase();
  };
  const sdpOf = (fps: Uint8Array[]) =>
    sdp(...fps.flatMap((f) => [`sha-256 ${hex(f, Math.random() < 0.5)}`, 'sha-1 AB']));

  it('both roles derive the same digest from their own local/remote SDP (200 runs)', async () => {
    for (let run = 0; run < 200; run++) {
      const fpO = Array.from({ length: 1 + (run % 3) }, () => rand(32));
      const fpA = Array.from({ length: 1 + ((run + 1) % 3) }, () => rand(32));
      const shuffled = (l: Uint8Array[]) => [...l, l[0]!].sort(() => Math.random() - 0.5);
      const base = { connId: rand(16), cO: rand(32), nO: rand(16), nA: rand(16) };
      // Each side sees its own SDP as local; order and case within the SDP must not matter.
      const asOfferer = await sasDigest({
        ...base,
        fpO: parseFingerprints(sdpOf(shuffled(fpO)))!,
        fpA: parseFingerprints(sdpOf(shuffled(fpA)))!,
      });
      const asAnswerer = await sasDigest({
        ...base,
        fpO: parseFingerprints(sdpOf(shuffled(fpO)))!,
        fpA: parseFingerprints(sdpOf(shuffled(fpA)))!,
      });
      expect(asAnswerer).toEqual(asOfferer);
    }
  });

  it('any single-bit change in any input changes the digest (200 runs)', async () => {
    for (let run = 0; run < 200; run++) {
      const i: SasInputs = {
        connId: rand(16),
        cO: rand(32),
        nO: rand(16),
        nA: rand(16),
        fpO: [rand(32)],
        fpA: [rand(32)],
      };
      const before = toB64url(await sasDigest(i));
      const fields = ['connId', 'cO', 'nO', 'nA', 'fpO', 'fpA'] as const;
      const field = fields[run % fields.length]!;
      const target = field === 'fpO' || field === 'fpA' ? i[field][0]! : i[field];
      target[run % target.length]! ^= 1 << (run % 8);
      expect(toB64url(await sasDigest(i))).not.toBe(before);
    }
  });
});
