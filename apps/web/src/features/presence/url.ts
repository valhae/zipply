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
