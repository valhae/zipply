import { MAX_SDP, PROTOCOL_VERSION, parseServerMessage } from '@zipply/protocol';
import type { Signal } from '../connection/peer';
import { fromB64url, toB64url } from '../connection/sas';

/**
 * Manual pairing codes (P7-03): an offer or answer that people carry between devices by copy/paste
 * or QR instead of signaling. `zipply1.` + base64url(deflate-raw(JSON)). The content is SDP with
 * ICE candidates, i.e. network addresses: never log, persist or send it anywhere. A decoded code is
 * untrusted and goes through the same schema as a signaling message.
 */
export type Description = Extract<Signal, { type: 'offer' | 'answer' }>;
export type Decoded =
  { ok: true; signal: Description } | { ok: false; reason: 'not-zipply' | 'invalid' };

const PREFIX = 'zipply1.';
/** Longest accepted code; a full-size SDP that does not compress at all still fits. */
export const MAX_CODE = 24_576;
const MAX_JSON = MAX_SDP + 512;

const pipe = (bytes: Uint8Array<ArrayBuffer>, t: CompressionStream | DecompressionStream) =>
  new Blob([bytes]).stream().pipeThrough(t);

export async function encodePairing({ type, payload }: Description): Promise<string> {
  const body = {
    t: type === 'offer' ? 'o' : 'a',
    c: payload.connId,
    k: 'cO' in payload ? payload.cO : payload.nA,
    s: payload.sdp,
  };
  const json = new TextEncoder().encode(JSON.stringify(body));
  const z = new Uint8Array(
    await new Response(pipe(json, new CompressionStream('deflate-raw'))).arrayBuffer(),
  );
  return PREFIX + toB64url(z);
}

/** Inflates at most `limit` bytes; a stream that expands further is abandoned (no bomb). */
export async function inflate(bytes: Uint8Array<ArrayBuffer>, limit: number) {
  const reader = pipe(bytes, new DecompressionStream('deflate-raw')).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

/** Decodes a pasted or scanned code into a signal for this device's own request id. */
export async function decodePairing(text: string, requestId: string): Promise<Decoded> {
  const code = text.replace(/\s+/g, '');
  if (!code.startsWith(PREFIX)) return { ok: false, reason: 'not-zipply' };
  const invalid = { ok: false, reason: 'invalid' } as const;
  const bytes = code.length <= MAX_CODE ? fromB64url(code.slice(PREFIX.length)) : null;
  const json = bytes && (await inflate(bytes as Uint8Array<ArrayBuffer>, MAX_JSON));
  if (!json) return invalid;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    return invalid;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid;
  const { t, c, k, s, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length || (t !== 'o' && t !== 'a')) return invalid;
  const message = {
    version: PROTOCOL_VERSION,
    type: t === 'o' ? 'offer' : 'answer',
    payload: { requestId, connId: c, sdp: s, [t === 'o' ? 'cO' : 'nA']: k },
  };
  const parsed = parseServerMessage(JSON.stringify(message));
  return parsed.ok ? { ok: true, signal: parsed.message as Description } : invalid;
}
