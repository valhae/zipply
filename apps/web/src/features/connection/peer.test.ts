// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { iceServers } from './peer';

describe('iceServers', () => {
  it('reads a comma-separated list of STUN URLs', () => {
    expect(iceServers(' stun:stun.cloudflare.com:3478, stun:example.org ')).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:example.org'] },
    ]);
  });

  it.each([undefined, '', ' , '])('uses no server for %j', (value) => {
    expect(iceServers(value)).toEqual([]);
  });

  it('drops anything that is not a STUN URL (no TURN relay, no other schemes)', () => {
    expect(iceServers('turn:relay.example:3478,http://x,stun:ok.example')).toEqual([
      { urls: ['stun:ok.example'] },
    ]);
  });
});
