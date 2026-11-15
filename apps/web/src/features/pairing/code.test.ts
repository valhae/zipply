// @vitest-environment node
import { MAX_SDP } from '@zipply/protocol';
import { describe, expect, it } from 'vitest';
import { randomBytes, toB64url } from '../connection/sas';
import { decodePairing, encodePairing, inflate, MAX_CODE } from './code';

const REQ = toB64url(new Uint8Array(16).fill(3));
const CONN = toB64url(new Uint8Array(16).fill(1));
const CO = toB64url(new Uint8Array(32).fill(7));
const NA = toB64url(new Uint8Array(16).fill(9));
const SDP = 'v=0\r\na=ice-ufrag:abcd\r\na=candidate:1 1 udp 2122 x.local 5000 typ host\r\n';

const offer = {
  type: 'offer' as const,
  payload: { requestId: REQ, connId: CONN, sdp: SDP, cO: CO },
};
const answer = {
  type: 'answer' as const,
  payload: { requestId: REQ, connId: CONN, sdp: SDP, nA: NA },
};

/** A code with any JSON body, built like the real encoder, for adversarial cases. */
async function raw(body: unknown, prefix = 'zipply1.') {
  const z = new Uint8Array(
    await new Response(
      new Blob([JSON.stringify(body)]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer(),
  );
  return prefix + toB64url(z);
}

describe('pairing codes (P7-03)', () => {
  it('round-trips an offer and an answer, stamped with the local request id', async () => {
    const other = toB64url(new Uint8Array(16).fill(5));
    expect(await decodePairing(await encodePairing(offer), other)).toEqual({
      ok: true,
      signal: { ...offer, payload: { ...offer.payload, requestId: other } },
    });
    expect(await decodePairing(await encodePairing(answer), REQ)).toEqual({
      ok: true,
      signal: answer,
    });
  });

  it('is compact text: a prefix and base64url only, smaller than the SDP JSON', async () => {
    const big = { ...offer, payload: { ...offer.payload, sdp: SDP.repeat(10) } };
    const code = await encodePairing(big);
    expect(code).toMatch(/^zipply1\.[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(JSON.stringify(big).length);
  });

  it('ignores spaces and line breaks added while copying', async () => {
    const code = await encodePairing(offer);
    const messy = ` ${code.slice(0, 20)}\n${code.slice(20, 40)} \r\n${code.slice(40)}\t`;
    expect(await decodePairing(messy, REQ)).toMatchObject({ ok: true });
  });

  it('says when the text is not a Zipply code at all', async () => {
    for (const text of ['', 'hello', 'https://example.org', 'zipply2.AAAA']) {
      expect(await decodePairing(text, REQ)).toEqual({ ok: false, reason: 'not-zipply' });
    }
  });

  it.each([
    ['broken base64url', 'zipply1.@@@@'],
    ['bytes that do not inflate', `zipply1.${toB64url(randomBytes(64))}`],
  ])('rejects %s', async (_, text) => {
    expect(await decodePairing(text, REQ)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an over-long code before decoding it', async () => {
    const text = `zipply1.${'A'.repeat(MAX_CODE)}`;
    expect(await decodePairing(text, REQ)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('stops inflating a small code that expands beyond the SDP limit (no decompression bomb)', async () => {
    const bomb = await raw({ t: 'o', c: CONN, k: CO, s: 'a'.repeat(MAX_SDP * 8) });
    expect(bomb.length).toBeLessThan(2000);
    expect(await decodePairing(bomb, REQ)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('inflate gives up as soon as the output passes the limit', async () => {
    const zeros = new Uint8Array(
      await new Response(
        new Blob([new Uint8Array(1 << 20)])
          .stream()
          .pipeThrough(new CompressionStream('deflate-raw')),
      ).arrayBuffer(),
    );
    expect(zeros.length).toBeLessThan(4096);
    expect(await inflate(zeros, 64 * 1024)).toBeNull();
    expect((await inflate(zeros, 1 << 20))?.length).toBe(1 << 20);
  });

  it.each([
    ['unknown kind', { t: 'x', c: CONN, k: CO, s: SDP }],
    ['extra field', { t: 'o', c: CONN, k: CO, s: SDP, verified: true }],
    ['missing SDP', { t: 'o', c: CONN, k: CO }],
    ['non-canonical connection id', { t: 'o', c: `${CONN}x`, k: CO, s: SDP }],
    ['offer with an answer-sized key', { t: 'o', c: CONN, k: NA, s: SDP }],
    ['answer with an offer-sized key', { t: 'a', c: CONN, k: CO, s: SDP }],
    ['SDP over the protocol limit', { t: 'o', c: CONN, k: CO, s: 'a'.repeat(MAX_SDP + 1) }],
    ['not an object', ['o', CONN, CO, SDP]],
  ])('rejects a code with %s (same schema as signaling)', async (_, body) => {
    expect(await decodePairing(await raw(body), REQ)).toEqual({ ok: false, reason: 'invalid' });
  });
});
