import { PROTOCOL_VERSION } from '@zipply/protocol';

// Phase 1: health route only. WebSocket signaling and the room Durable Object arrive in Phase 4.
// Never log request bodies or headers here (privacy: see docs/SECURITY_DECISIONS.md).
export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname !== '/healthz') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
    }
    return Response.json(
      { status: 'ok', protocolVersion: PROTOCOL_VERSION },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
} satisfies ExportedHandler;
