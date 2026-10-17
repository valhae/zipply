import { PROTOCOL_VERSION } from '@zipply/protocol';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const call = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://signaling.test${path}`, init);
const upgrade = (origin: string | null, extra: Record<string, string> = {}) => ({
  headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}), ...extra },
});
const ROOM_HASH = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

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

  it.each(['/', '/healthz/', '/HEALTHZ', '/upload', '/ws/', '/ws/short', `/ws/${ROOM_HASH}/x`])(
    '%s returns 404',
    async (path) => {
      const res = await call(path, upgrade('http://localhost:5173'));
      expect(res.status).toBe(404);
    },
  );

  it('rejects a non-canonical room hash', async () => {
    const res = await call(`/ws/${ROOM_HASH.slice(0, -1)}B`, upgrade('http://localhost:5173'));
    expect(res.status).toBe(404);
  });
});

describe('WebSocket upgrade checks (P4-02)', () => {
  it('accepts an allowed origin', async () => {
    const res = await call('/ws', upgrade('http://localhost:5173'));
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it.each([
    ['unknown origin', 'https://evil.example'],
    ['look-alike origin', 'http://localhost:5173.evil.example'],
    ['missing origin', null],
    ['null origin', 'null'],
  ])('rejects %s with 403', async (_, origin) => {
    const res = await call('/ws', upgrade(origin));
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
    expect(await res.text()).toBe('Forbidden');
  });

  // workers.dev also answers plain HTTP; signaling must never run unencrypted (spec §38.4/§38.7).
  it('refuses a plaintext ws:// upgrade from the internet', async () => {
    const res = await SELF.fetch('http://signaling.example/ws', upgrade('http://localhost:5173'));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('HTTPS required');
  });

  it.each(['http://localhost:8787/ws', 'http://127.0.0.1:8787/ws'])(
    'allows plaintext only for local development (%s)',
    async (url) => {
      const res = await SELF.fetch(url, upgrade('http://localhost:5173'));
      expect(res.status).toBe(101);
      res.webSocket!.accept();
      res.webSocket!.close();
    },
  );

  it('requires a WebSocket upgrade', async () => {
    const res = await call('/ws', { headers: { Origin: 'http://localhost:5173' } });
    expect(res.status).toBe(426);
  });

  // The runtime's fetch always sends an Upgrade request as GET, so the method check is tested without it.
  it('requires GET', async () => {
    const res = await call('/ws', { method: 'POST', headers: { Origin: 'http://localhost:5173' } });
    expect(res.status).toBe(405);
  });
});
