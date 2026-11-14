// Dependency-free: also imported by vite.config.ts at build time.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Production signaling must be wss://; plain ws:// is accepted only for localhost development. */
export function signalingUrlProblem(
  url: string | undefined,
): 'missing' | 'invalid' | 'insecure' | null {
  if (!url) return 'missing';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol === 'wss:') return null;
  if (parsed.protocol !== 'ws:') return 'invalid';
  return LOCAL_HOSTS.includes(parsed.hostname) ? null : 'insecure';
}

/**
 * The build-dependent part of the CSP (SD-09), sent as a <meta> tag: the signaling origin and the
 * inline theme script's hash differ per build. Header-only directives live in vercel.json.
 */
export function contentSecurityPolicy(signalingUrl: string | undefined, scriptHashes: string[]) {
  const signaling = signalingUrlProblem(signalingUrl) === null ? new URL(signalingUrl!).origin : '';
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)].join(' '),
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${signaling && ` ${signaling}`}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
