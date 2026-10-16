import { describe, expect, it } from 'vitest';
import { MAX_ENVELOPE_BYTES, PROTOCOL_VERSION, parseEnvelope } from './index';

const reject = (raw: string) => {
  const result = parseEnvelope(raw);
  if (result.ok) throw new Error(`expected rejection for ${raw.slice(0, 80)}`);
  return result.code;
};

describe('parseEnvelope', () => {
  it('accepts a minimal envelope and defaults payload to an empty object', () => {
    expect(parseEnvelope('{"version":1,"type":"heartbeat"}')).toEqual({
      ok: true,
      envelope: { version: PROTOCOL_VERSION, type: 'heartbeat', payload: {} },
    });
  });

  it('accepts requestId and an object payload', () => {
    const raw = JSON.stringify({
      version: 1,
      type: 'hello',
      requestId: 'aB3_-x',
      payload: { a: 1 },
    });
    expect(parseEnvelope(raw)).toEqual({
      ok: true,
      envelope: { version: 1, type: 'hello', requestId: 'aB3_-x', payload: { a: 1 } },
    });
  });

  it('rejects malformed JSON', () => {
    expect(reject('{"version":1,')).toBe('INVALID_MESSAGE');
  });

  it.each(['[]', 'null', '"hello"', '42', 'true'])('rejects non-object JSON %s', (raw) => {
    expect(reject(raw)).toBe('INVALID_MESSAGE');
  });

  it('rejects an unsupported numeric version', () => {
    expect(reject('{"version":2,"type":"heartbeat"}')).toBe('UNSUPPORTED_VERSION');
  });

  it.each(['{"type":"heartbeat"}', '{"version":"1","type":"heartbeat"}'])(
    'rejects a missing or non-numeric version %s',
    (raw) => {
      expect(reject(raw)).toBe('INVALID_MESSAGE');
    },
  );

  it.each([
    '{"version":1,"type":"heartbeat","extra":true}',
    '{"version":1,"type":"heartbeat","__proto__":{"polluted":true}}',
  ])('rejects unknown top-level fields %s', (raw) => {
    expect(reject(raw)).toBe('INVALID_MESSAGE');
  });

  it.each([
    '{"version":1}',
    '{"version":1,"type":""}',
    '{"version":1,"type":"Hello"}',
    '{"version":1,"type":"he llo"}',
    '{"version":1,"type":"<script>"}',
    '{"version":1,"type":7}',
    `{"version":1,"type":"${'a'.repeat(65)}"}`,
  ])('rejects a missing or malformed type %s', (raw) => {
    expect(reject(raw)).toBe('INVALID_MESSAGE');
  });

  it.each([
    '{"version":1,"type":"x","requestId":""}',
    '{"version":1,"type":"x","requestId":"has space"}',
    '{"version":1,"type":"x","requestId":5}',
    `{"version":1,"type":"x","requestId":"${'a'.repeat(65)}"}`,
  ])('rejects a malformed requestId %s', (raw) => {
    expect(reject(raw)).toBe('INVALID_MESSAGE');
  });

  it.each(['[]', 'null', '"x"', '1'])('rejects a non-object payload %s', (payload) => {
    expect(reject(`{"version":1,"type":"x","payload":${payload}}`)).toBe('INVALID_MESSAGE');
  });

  it('accepts an envelope of exactly MAX_ENVELOPE_BYTES UTF-8 bytes', () => {
    const base = '{"version":1,"type":"x","payload":{"pad":""}}';
    const raw = base.replace('""', `"${'a'.repeat(MAX_ENVELOPE_BYTES - base.length)}"`);
    expect(raw.length).toBe(MAX_ENVELOPE_BYTES); // ASCII only, so UTF-16 length == UTF-8 bytes
    expect(parseEnvelope(raw).ok).toBe(true);
  });

  it('rejects input one byte over the limit', () => {
    const base = '{"version":1,"type":"x","payload":{"pad":""}}';
    const raw = base.replace('""', `"${'a'.repeat(MAX_ENVELOPE_BYTES - base.length + 1)}"`);
    expect(reject(raw)).toBe('MESSAGE_TOO_LARGE');
  });

  it('measures size in UTF-8 bytes, not string length', () => {
    // 30,000 three-byte characters: 30k UTF-16 units but ~90 KB of UTF-8.
    const raw = `{"version":1,"type":"x","payload":{"pad":"${'€'.repeat(30_000)}"}}`;
    expect(raw.length).toBeLessThan(MAX_ENVELOPE_BYTES);
    expect(reject(raw)).toBe('MESSAGE_TOO_LARGE');
  });
});
