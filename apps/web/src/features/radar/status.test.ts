import { describe, expect, it } from 'vitest';
import { discoveryStatus } from './status';

describe('discoveryStatus', () => {
  it.each([
    ['online', true, 'visible'],
    ['online', false, 'invisible'],
    ['offline', true, 'offline'],
    ['connecting', true, 'connecting'],
    ['reconnecting', false, 'reconnecting'],
  ] as const)('%s + discoverable=%s → %s', (connection, discoverable, expected) => {
    expect(discoveryStatus(connection, discoverable)).toBe(expected);
  });
});
