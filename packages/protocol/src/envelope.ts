// Signaling protocol shared by the browser client and the Worker.
// Must stay runtime-neutral: no DOM, no Workers APIs (enforced by tsconfig `lib`/`types` and ESLint).

export const PROTOCOL_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 65_536;

export type EnvelopeErrorCode = 'INVALID_MESSAGE' | 'UNSUPPORTED_VERSION' | 'MESSAGE_TOO_LARGE';

export interface Envelope {
  version: typeof PROTOCOL_VERSION;
  type: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

export type ParseResult = { ok: true; envelope: Envelope } | { ok: false; code: EnvelopeErrorCode };

const ENVELOPE_KEYS = new Set(['version', 'type', 'requestId', 'payload']);
const TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const fail = (code: EnvelopeErrorCode): ParseResult => ({ ok: false, code });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// UTF-8 byte length without TextEncoder (not in the ES lib this package is limited to).
// Lone surrogates count as 3 bytes, matching TextEncoder's U+FFFD replacement.
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Strictly parses one signaling envelope. Per-type payload schemas are validated separately. */
export function parseEnvelope(raw: string): ParseResult {
  // UTF-8 bytes >= UTF-16 length, so the cheap length check can reject early.
  if (raw.length > MAX_ENVELOPE_BYTES || utf8ByteLength(raw) > MAX_ENVELOPE_BYTES) {
    return fail('MESSAGE_TOO_LARGE');
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('INVALID_MESSAGE');
  }
  if (!isPlainObject(data)) return fail('INVALID_MESSAGE');
  if (Object.keys(data).some((key) => !ENVELOPE_KEYS.has(key))) return fail('INVALID_MESSAGE');

  const { version, type, requestId, payload = {} } = data;
  if (typeof version !== 'number') return fail('INVALID_MESSAGE');
  if (version !== PROTOCOL_VERSION) return fail('UNSUPPORTED_VERSION');
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) return fail('INVALID_MESSAGE');
  if (
    requestId !== undefined &&
    (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId))
  ) {
    return fail('INVALID_MESSAGE');
  }
  if (!isPlainObject(payload)) return fail('INVALID_MESSAGE');

  return {
    ok: true,
    envelope: { version, type, ...(requestId === undefined ? {} : { requestId }), payload },
  };
}
