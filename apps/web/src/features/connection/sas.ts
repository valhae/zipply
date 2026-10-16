// SAS v1 with commit-then-reveal (docs/SECURITY_DECISIONS.md SD-02). Never log any of these values.
import { WORDLIST } from './wordlist';

export interface SasInputs {
  connId: Uint8Array;
  cO: Uint8Array;
  nO: Uint8Array;
  nA: Uint8Array;
  fpO: Uint8Array[];
  fpA: Uint8Array[];
}

const enc = new TextEncoder();
const B64URL = /^[A-Za-z0-9_-]*$/;

export function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict decode: returns null for anything that does not re-encode to the same string. */
export function fromB64url(text: string): Uint8Array | null {
  if (!B64URL.test(text) || text.length % 4 === 1) return null;
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return toB64url(bytes) === text ? bytes : null;
}

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const sha256 = async (...parts: Uint8Array[]) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', concat(parts)));

const FINGERPRINT_LINE = /^a=fingerprint:(\S+) (\S+)$/;
const SHA256_HEX = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

/** sha-256 DTLS fingerprints from an SDP, deduplicated and sorted; null (fail closed) if none or any is malformed. */
export function parseFingerprints(sdp: string): Uint8Array[] | null {
  const hex = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const m = FINGERPRINT_LINE.exec(line);
    if (!m || m[1]!.toLowerCase() !== 'sha-256') continue;
    const value = m[2]!.toUpperCase();
    if (!SHA256_HEX.test(value)) return null;
    hex.add(value.replace(/:/g, ''));
  }
  if (hex.size === 0) return null;
  return [...hex].sort().map((h) => Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16)));
}

export const commit = (connId: Uint8Array, nO: Uint8Array) =>
  sha256(enc.encode('zipply/sas-commit/v1'), connId, nO);

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/** D = SHA-256 of the role-ordered, length-prefixed transcript T. Throws on malformed inputs. */
export async function sasDigest(i: SasInputs): Promise<Uint8Array> {
  const sizes: [Uint8Array, number][] = [
    [i.connId, 16],
    [i.cO, 32],
    [i.nO, 16],
    [i.nA, 16],
  ];
  if (sizes.some(([b, n]) => b.length !== n)) throw new Error('Invalid SAS input length');
  for (const list of [i.fpO, i.fpA]) {
    if (list.length === 0 || list.some((fp) => fp.length !== 32)) {
      throw new Error('Invalid fingerprint list');
    }
  }
  return sha256(
    ...[
      enc.encode('zipply/sas/v1'),
      new Uint8Array([1]),
      i.connId,
      concat(i.fpO),
      concat(i.fpA),
      i.cO,
      i.nO,
      i.nA,
    ].map(lengthPrefixed),
  );
}

/** Six words from the first 66 bits of D (six big-endian 11-bit indices). */
export function phrase(d: Uint8Array): string[] {
  let bits = '';
  for (const b of d.subarray(0, 9)) bits += b.toString(2).padStart(8, '0');
  return Array.from(
    { length: 6 },
    (_, k) => WORDLIST[parseInt(bits.slice(k * 11, k * 11 + 11), 2)]!,
  );
}
