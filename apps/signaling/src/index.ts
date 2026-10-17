import { PROTOCOL_VERSION } from '@zipply/protocol';
import type { Room } from './room';

export { Room } from './room';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- global binding types, as `wrangler types` emits
  namespace Cloudflare {
    interface Env {
      ROOM: DurableObjectNamespace<Room>;
      /** Comma-separated exact origins allowed to open a WebSocket. Unset means nobody (fail closed). */
      ALLOWED_ORIGINS?: string;
    }
  }
}
type Env = Cloudflare.Env;

// `/ws` is the public lobby; `/ws/<base64url(SHA-256(capability))>` is a private room (SD-05).
const WS_PATH = /^\/ws(?:\/([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]))?$/;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const text = (body: string, status: number, headers?: HeadersInit) =>
  new Response(body, { status, headers });

function originAllowed(origin: string | null, allowed: string | undefined): boolean {
  if (!origin || !allowed) return false;
  return allowed
    .split(',')
    .map((o) => o.trim())
    .includes(origin);
}

// Never log request bodies, headers, SDP or candidates here (SD-08, spec §38.4).
export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const { pathname, protocol, hostname } = new URL(request.url);
    if (pathname === '/healthz') {
      if (request.method !== 'GET') return text('Method not allowed', 405, { allow: 'GET' });
      return Response.json(
        { status: 'ok', protocolVersion: PROTOCOL_VERSION },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    const match = WS_PATH.exec(pathname);
    if (!match) return text('Not found', 404);
    if (request.method !== 'GET') return text('Method not allowed', 405, { allow: 'GET' });
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return text('Upgrade required', 426, { upgrade: 'websocket' });
    }
    // workers.dev also answers plain HTTP: never run signaling unencrypted outside local development.
    if (protocol !== 'https:' && !LOCAL_HOSTS.includes(hostname))
      return text('HTTPS required', 403);
    if (!originAllowed(request.headers.get('origin'), env.ALLOWED_ORIGINS)) {
      return text('Forbidden', 403);
    }

    const roomHash = match[1] ?? '';
    const room = env.ROOM.get(env.ROOM.idFromName(roomHash ? `room:${roomHash}` : 'public'));
    // Only the upgrade and the route hash reach the room; nothing else from the client request.
    return room.fetch('https://room.internal/ws', {
      headers: { upgrade: 'websocket', 'x-zipply-room': roomHash },
    });
  },
} satisfies ExportedHandler<Env>;
