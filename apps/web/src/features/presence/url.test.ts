// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './url';

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name, values.join(' ')];
    }),
  );

describe('contentSecurityPolicy (P5-08, SD-09)', () => {
  it('allows only this origin, the signaling origin and the hashed inline scripts', () => {
    const d = directives(contentSecurityPolicy('wss://signal.example/ws', ['abc=', 'def=']));
    expect(d).toEqual({
      'default-src': "'self'",
      'script-src': "'self' 'sha256-abc=' 'sha256-def='",
      'style-src': "'self'",
      'img-src': "'self' data: blob:",
      'font-src': "'self'",
      'connect-src': "'self' wss://signal.example",
      'worker-src': "'self'",
      'manifest-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
    });
  });

  it('allows plaintext ws only for local development', () => {
    expect(directives(contentSecurityPolicy('ws://localhost:8787/ws', []))['connect-src']).toBe(
      "'self' ws://localhost:8787",
    );
  });

  it.each([undefined, '', 'ws://signal.example/ws', 'https://x.example'])(
    'adds no signaling origin for %j',
    (url) => {
      expect(directives(contentSecurityPolicy(url, []))['connect-src']).toBe("'self'");
    },
  );
});
