// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fromB64url, sha256, toB64url } from '../connection/sas';
import { createRoom, readRoom } from './room';

const NOW = 1_800_000_000_000;

describe('private room capability (SD-05)', () => {
  it('is 16 random bytes plus an expiry minute, routed by its SHA-256', async () => {
    const room = await createRoom(30, NOW);
    const bytes = fromB64url(room.capability)!;
    expect(bytes).toHaveLength(20);
    expect(new DataView(bytes.buffer).getUint32(16)).toBe(Math.floor(NOW / 60_000) + 30);
    expect(room.hash).toBe(toB64url(await sha256(bytes)));
    expect(room.expiresAt).toBe((Math.floor(NOW / 60_000) + 30) * 60_000);
    expect((await createRoom(30, NOW)).capability).not.toBe(room.capability);
  });

  it('reads a valid capability back from the URL fragment', async () => {
    const room = await createRoom(30, NOW);
    expect(await readRoom(`#room=${room.capability}`, NOW)).toEqual(room);
  });

  it.each([
    ['empty', ''],
    ['other fragment', '#about'],
    ['extra parameters', '#room=AAECAwQFBgcICQoLDA0ODxAREhM&x=1'],
    ['wrong length', '#room=AAECAwQFBgcICQoLDA0ODw'],
    ['not base64url', '#room=AAECAwQFBgcICQoLDA0ODxAREh+'],
  ])('rejects %s', async (_, fragment) => {
    expect(await readRoom(fragment, NOW)).toBeNull();
  });

  it('rejects an expired capability', async () => {
    const room = await createRoom(1, NOW);
    expect(await readRoom(`#room=${room.capability}`, NOW + 61_000)).toBeNull();
  });
});
