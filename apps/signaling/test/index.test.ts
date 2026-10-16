import { PROTOCOL_VERSION } from '@zipply/protocol';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://signaling.test${path}`, init));

describe('signaling worker', () => {
  it('GET /healthz returns 200 with status and protocol version, not cacheable', async () => {
    const res = await call('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', protocolVersion: PROTOCOL_VERSION });
  });

  it.each(['POST', 'PUT', 'DELETE'])('%s /healthz returns 405 with Allow: GET', async (method) => {
    const res = await call('/healthz', { method });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it.each(['/', '/ws', '/healthz/', '/HEALTHZ', '/upload'])('%s returns 404', async (path) => {
    const res = await call(path);
    expect(res.status).toBe(404);
  });
});
