import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  encodeMessage,
  isValidDisplayName,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from './messages';

const ID = 'AAECAwQFBgcICQoLDA0ODw'; // 16 bytes, canonical base64url
const ID2 = 'EBESExQVFhcYGRobHB0eHw';
const D32 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'; // 32 bytes
const ROOM = 'AAECAwQFBgcICQoLDA0ODxAREhM'; // 20 bytes
const candidate = {
  candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
};

const CLIENT: ClientMessage[] = [
  { type: 'hello', payload: { displayName: 'Guest 4821', discoverable: false } },
  { type: 'hello', payload: { displayName: 'Bücher 📚', discoverable: true, room: ROOM } },
  { type: 'visibility', payload: { discoverable: true } },
  { type: 'connection-request', payload: { requestId: ID, targetPeerId: ID2 } },
  { type: 'connection-response', payload: { requestId: ID, accept: false } },
  { type: 'offer', payload: { requestId: ID, connId: ID2, sdp: 'v=0', cO: D32 } },
  { type: 'answer', payload: { requestId: ID, connId: ID2, sdp: 'v=0', nA: ID } },
  { type: 'ice-candidate', payload: { requestId: ID, connId: ID2, candidate } },
  {
    type: 'ice-candidate',
    payload: {
      requestId: ID,
      connId: ID2,
      candidate: { ...candidate, sdpMid: null, usernameFragment: 'ab' },
    },
  },
  { type: 'cancel', payload: { requestId: ID } },
];

const SERVER: ServerMessage[] = [
  { type: 'hello-accepted', payload: { peerId: ID, heartbeatSeconds: 20, presenceTtlSeconds: 60 } },
  { type: 'peer-snapshot', payload: { peers: [{ peerId: ID2, displayName: 'Alex' }] } },
  { type: 'peer-snapshot', payload: { peers: [] } },
  { type: 'peer-joined', payload: { peer: { peerId: ID2, displayName: 'Alex' } } },
  { type: 'peer-left', payload: { peerId: ID2 } },
  {
    type: 'connection-request',
    payload: { requestId: ID, fromPeerId: ID2, displayName: 'Alex', expiresAt: 1_800_000_000_000 },
  },
  { type: 'connection-response', payload: { requestId: ID, accept: true } },
  { type: 'offer', payload: { requestId: ID, connId: ID2, sdp: 'v=0', cO: D32 } },
  { type: 'answer', payload: { requestId: ID, connId: ID2, sdp: 'v=0', nA: ID } },
  { type: 'ice-candidate', payload: { requestId: ID, connId: ID2, candidate } },
  { type: 'cancel', payload: { requestId: ID } },
  { type: 'error', payload: { code: 'RATE_LIMITED' } },
];

const raw = (type: string, payload: unknown, version = 1) =>
  JSON.stringify({ version, type, payload });
const clientCode = (text: string) => {
  const r = parseClientMessage(text);
  return r.ok ? 'ok' : r.code;
};

describe('valid messages', () => {
  it.each(CLIENT.map((m) => [m.type, m] as const))('client %s round-trips', (_, m) => {
    expect(parseClientMessage(encodeMessage(m))).toEqual({ ok: true, message: m });
  });
  it.each(SERVER.map((m) => [m.type, m] as const))('server %s round-trips', (_, m) => {
    expect(parseServerMessage(encodeMessage(m))).toEqual({ ok: true, message: m });
  });
});

describe('client messages are rejected when malformed', () => {
  it.each([
    ['unknown type', raw('upload', {})],
    ['server-only type from a client', raw('peer-snapshot', { peers: [] })],
    ['missing field', raw('visibility', {})],
    ['extra field', raw('visibility', { discoverable: true, peerId: ID })],
    ['wrong type', raw('visibility', { discoverable: 'yes' })],
    ['short id', raw('cancel', { requestId: 'AAEC' })],
    ['non-canonical id', raw('cancel', { requestId: ID.slice(0, -1) + 'B' })],
    ['padded id', raw('cancel', { requestId: ID + '==' })],
    [
      'oversize SDP',
      raw('offer', { requestId: ID, connId: ID2, sdp: 'x'.repeat(16_385), cO: D32 }),
    ],
    ['offer without commitment', raw('offer', { requestId: ID, connId: ID2, sdp: 'v=0' })],
    [
      'answer with a commitment instead of nA',
      raw('answer', { requestId: ID, connId: ID2, sdp: 'v=0', cO: D32 }),
    ],
    [
      'oversize candidate',
      raw('ice-candidate', {
        requestId: ID,
        connId: ID2,
        candidate: { ...candidate, candidate: 'x'.repeat(1025) },
      }),
    ],
    [
      'candidate extra field',
      raw('ice-candidate', {
        requestId: ID,
        connId: ID2,
        candidate: { ...candidate, address: '192.0.2.1' },
      }),
    ],
    ['bad room capability', raw('hello', { displayName: 'A', discoverable: true, room: ID })],
  ])('%s', (_, text) => {
    expect(clientCode(text)).toBe('INVALID_MESSAGE');
  });

  // Manifest privacy by schema: signaling can never carry file metadata (SD-03, spec §38.4).
  it.each([
    'fileName',
    'fileSize',
    'files',
    'totalBytes',
    'mimeType',
    'manifestDigest',
    'fileCount',
  ])('connection-request with %s is rejected', (field) => {
    expect(
      clientCode(raw('connection-request', { requestId: ID, targetPeerId: ID2, [field]: 1 })),
    ).toBe('INVALID_MESSAGE');
  });

  it('unsupported version and oversize input have their own codes', () => {
    expect(clientCode(raw('visibility', { discoverable: true }, 2))).toBe('UNSUPPORTED_VERSION');
    expect(clientCode(raw('offer', { sdp: 'x'.repeat(70_000) }))).toBe('MESSAGE_TOO_LARGE');
  });
});

describe('server messages cannot assert trust', () => {
  it.each([
    [
      'verified flag',
      raw('peer-joined', { peer: { peerId: ID2, displayName: 'A', verified: true } }),
    ],
    ['unknown trust message', raw('peer-verified', { peerId: ID2 })],
    [
      'extra hello-accepted field',
      raw('hello-accepted', { peerId: ID, heartbeatSeconds: 20, presenceTtlSeconds: 60, sas: 'x' }),
    ],
    ['unknown error code', raw('error', { code: 'OOPS' })],
    ['client-only type', raw('hello', { displayName: 'A', discoverable: true })],
    ['invalid display name', raw('peer-joined', { peer: { peerId: ID2, displayName: 'a‮b' } })],
  ])('%s is rejected', (_, text) => {
    const r = parseServerMessage(text);
    expect(r.ok).toBe(false);
  });
});

describe('isValidDisplayName (SD-05)', () => {
  it.each(['A', 'Guest 4821', 'Bücher 📚', 'x'.repeat(32), '👨‍👩‍👧 family', 'مرحبا'])(
    'accepts %j',
    (name) => {
      expect(isValidDisplayName(name)).toBe(true);
    },
  );
  it.each([
    ['empty', ''],
    ['33 characters', 'x'.repeat(33)],
    ['leading space', ' Alex'],
    ['trailing space', 'Alex '],
    ['control character', 'Al\u0007ex'],
    ['newline', 'Al\nex'],
    ['right-to-left override', 'photo‮gnp.exe'],
    ['bidi isolate', 'a⁦b'],
    ['not NFC', 'Bücher'],
    ['lone surrogate', 'a\uD800b'],
  ])('rejects %s', (_, name) => {
    expect(isValidDisplayName(name)).toBe(false);
  });
});

describe('properties (fast-check)', () => {
  it('never throws on arbitrary strings or JSON', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        parseClientMessage(text);
        parseServerMessage(text);
      }),
      { numRuns: 2000 },
    );
  });

  it('rejects any valid client message with one extra payload key', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLIENT),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.jsonValue(),
        (m, key, value) => {
          fc.pre(!Object.hasOwn(m.payload, key));
          const text = raw(m.type, { ...m.payload, [key]: value });
          expect(parseClientMessage(text).ok).toBe(false);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('accepts exactly the display names that pass isValidDisplayName in hello', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40, unit: 'grapheme' }),
        fc.boolean(),
        (name, discoverable) => {
          const ok = parseClientMessage(raw('hello', { displayName: name, discoverable })).ok;
          expect(ok).toBe(isValidDisplayName(name));
        },
      ),
      { numRuns: 1000 },
    );
  });
});
