// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { sha256, toB64url } from '../connection/sas';
import { decodeChunk } from './frames';
import { sendFile, type SendChannel } from './sender';

const ID = 'AAECAwQFBgcICQoLDA0ODw';
const CHUNK = 1024;

// Fake DataChannel: buffer grows on send and drains asynchronously, firing bufferedamountlow like a browser.
function fakeChannel(drainPerTick = 1500) {
  let buffered = 0;
  let max = 0;
  const sent: ArrayBuffer[] = [];
  const listeners = new Set<() => void>();
  const drain = () => {
    const before = buffered;
    buffered = Math.max(0, buffered - drainPerTick);
    if (before > ch.bufferedAmountLowThreshold && buffered <= ch.bufferedAmountLowThreshold) {
      listeners.forEach((fn) => fn());
    }
    if (buffered > 0) setTimeout(drain, 0);
  };
  const ch: SendChannel = {
    get bufferedAmount() {
      return buffered;
    },
    bufferedAmountLowThreshold: 0,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  const send = (frame: ArrayBuffer) => {
    sent.push(frame);
    buffered += frame.byteLength;
    max = Math.max(max, buffered);
    if (buffered === frame.byteLength) setTimeout(drain, 0);
  };
  return { ch, send, sent, max: () => max };
}

const random = (n: number) => Uint8Array.from({ length: n }, () => (Math.random() * 256) | 0);
const opts = (fake: ReturnType<typeof fakeChannel>, over = {}) => ({
  channel: fake.ch,
  send: fake.send,
  fileIdx: 3,
  transferId: ID,
  chunkSize: CHUNK,
  high: 4 * 1024,
  low: 1024,
  signal: new AbortController().signal,
  ...over,
});

describe('sendFile', () => {
  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 10 * CHUNK + 7])(
    'sends %i bytes as ordered, verifiable chunks',
    async (size) => {
      const data = random(size);
      const fake = fakeChannel();
      const root = await sendFile(new Blob([data]), opts(fake));

      const frames = fake.sent.map((f) => decodeChunk(f, CHUNK)!);
      expect(frames).toHaveLength(Math.ceil(size / CHUNK));
      const rebuilt = new Uint8Array(size);
      for (const [i, { header, payload }] of frames.entries()) {
        expect(header).toMatchObject({
          fileIdx: 3,
          chunkIdx: i,
          offset: i * CHUNK,
          transferId: ID,
        });
        expect(header.final).toBe(i === frames.length - 1);
        expect(header.digest).toEqual(await sha256(payload));
        rebuilt.set(payload, header.offset);
      }
      expect(rebuilt).toEqual(data);
      expect(root).toBe(toB64url(await sha256(...frames.map((f) => f.header.digest))));
    },
  );

  it('never buffers more than the high watermark', async () => {
    const fake = fakeChannel(700);
    await sendFile(new Blob([random(50 * CHUNK)]), opts(fake));
    expect(fake.max()).toBeLessThanOrEqual(4 * 1024);
    expect(fake.ch.bufferedAmountLowThreshold).toBe(1024);
  });

  it('reads the file in chunk-sized slices only', async () => {
    const blob = new Blob([random(5 * CHUNK + 3)]);
    const slice = vi.spyOn(blob, 'slice');
    await sendFile(blob, opts(fakeChannel()));
    expect(slice).toHaveBeenCalledTimes(6);
    for (const [start, end] of slice.mock.calls) expect(end! - start!).toBeLessThanOrEqual(CHUNK);
  });

  it('stops when the gate refuses to send', async () => {
    const fake = fakeChannel();
    let calls = 0;
    const send = () => {
      calls++;
      throw new Error('gate closed');
    };
    await expect(sendFile(new Blob([random(3 * CHUNK)]), opts(fake, { send }))).rejects.toThrow(
      'gate closed',
    );
    expect(calls).toBe(1);
  });

  it('stops on cancel while waiting for the buffer to drain', async () => {
    const fake = fakeChannel(0); // never drains
    const abort = new AbortController();
    const done = sendFile(new Blob([random(20 * CHUNK)]), opts(fake, { signal: abort.signal }));
    await new Promise((r) => setTimeout(r, 10));
    const sentBefore = fake.sent.length;
    abort.abort();
    await expect(done).rejects.toThrow();
    expect(fake.sent.length).toBe(sentBefore);
    expect(sentBefore).toBeLessThan(20);
  });

  it('rejects watermarks that could deadlock', async () => {
    await expect(
      sendFile(new Blob([random(10)]), opts(fakeChannel(), { high: 1500 })),
    ).rejects.toThrow();
  });
});
