// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { iceServers, parseSignal } from './peer';

const ID16 = 'AAECAwQFBgcICQoLDA0ODw';
const ID32 = 'A'.repeat(43);
const candidate = {
  candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
};

describe('parseSignal', () => {
  it.each([
    { kind: 'offer', connId: ID16, sdp: 'v=0', cO: ID32 },
    { kind: 'answer', connId: ID16, sdp: 'v=0', nA: ID16 },
    { kind: 'ice', connId: ID16, candidate },
    {
      kind: 'ice',
      connId: ID16,
      candidate: { ...candidate, sdpMid: null, usernameFragment: 'abcd' },
    },
  ])('accepts $kind', (signal) => {
    expect(parseSignal(signal)).toEqual(signal);
  });

  it.each([
    ['null', null],
    ['unknown kind', { kind: 'verified', connId: ID16 }],
    ['offer without commitment', { kind: 'offer', connId: ID16, sdp: 'v=0' }],
    ['short commitment', { kind: 'offer', connId: ID16, sdp: 'v=0', cO: ID16 }],
    ['short answer nonce', { kind: 'answer', connId: ID16, sdp: 'v=0', nA: 'AAEC' }],
    ['bad connId', { kind: 'answer', connId: 'x', sdp: 'v=0', nA: ID16 }],
    ['oversize SDP', { kind: 'offer', connId: ID16, sdp: 'x'.repeat(16 * 1024 + 1), cO: ID32 }],
    ['extra field', { kind: 'answer', connId: ID16, sdp: 'v=0', nA: ID16, verified: true }],
    [
      'oversize candidate',
      { kind: 'ice', connId: ID16, candidate: { ...candidate, candidate: 'x'.repeat(1025) } },
    ],
    ['candidate extra field', { kind: 'ice', connId: ID16, candidate: { ...candidate, foo: 1 } }],
    [
      'candidate bad index',
      { kind: 'ice', connId: ID16, candidate: { ...candidate, sdpMLineIndex: -1 } },
    ],
  ])('rejects %s', (_, value) => {
    expect(parseSignal(value)).toBeNull();
  });
});

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
