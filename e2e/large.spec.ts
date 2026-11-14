import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { connect, openTabs, saved, sent, skipWithoutWebRTC, status, verify } from './webrtc';

// P6-01 / P6-02 / P6-06: transfers above the 256 MiB memory cap go to a disk sink (D21): a folder
// picked with File System Access (Chromium desktop; the native picker is replaced by an OPFS
// folder, because automation cannot drive it), or OPFS staging plus an automatic download.

test.describe.configure({ mode: 'default', timeout: 240_000 });
test.beforeEach(async ({ page }, testInfo) => skipWithoutWebRTC(page, testInfo));

const MiB = 1024 * 1024;
const SIZE = 260 * MiB;
const SLICE = 16 * MiB;
const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A random file written in slices, with the SHA-256 of each slice and of the whole file. */
async function bigFile(testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  const fh = await open(path, 'w');
  const whole = createHash('sha256');
  const slices: string[] = [];
  for (let o = 0; o < SIZE; o += SLICE) {
    const part = randomBytes(Math.min(SLICE, SIZE - o));
    whole.update(part);
    slices.push(hex(part));
    await fh.write(part);
  }
  await fh.close();
  return { name, path, slices, sha: whole.digest('hex') };
}

const hashFile = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

const noPicker = (p: Page) =>
  p.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }),
  );
const opfsPicker = (p: Page) =>
  p.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true }),
    }),
  );

/** Names of the staging folders in this origin's OPFS. */
const staging = (p: Page) =>
  p.evaluate(async () => {
    const names: string[] = [];
    for await (const [name] of (await navigator.storage.getDirectory()).entries()) {
      if (name.startsWith('zipply-')) names.push(name);
    }
    return names;
  });

async function offer(sender: Page, receiver: Page, receiverName: string, path: string) {
  await (
    await connect(sender, receiver, receiverName, path)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  return receiver.getByRole('dialog', { name: 'Incoming files' });
}

test('a folder picked on Chromium receives the file directly, byte-exact (P6-01)', async ({
  page,
}, testInfo) => {
  const f = await bigFile(testInfo, 'folder.bin');
  const { sender, receiver, receiverName } = await openTabs(page, {
    before: (p, who) => (who === 'receiver' ? opfsPicker(p) : Promise.resolve()),
  });
  const incoming = await offer(sender, receiver, receiverName, f.path);
  await expect(incoming).toContainText('choose a folder');
  await incoming.getByRole('button', { name: 'Accept files' }).click();
  await expect(status(receiver)).toContainText('saved in the folder you chose', {
    timeout: 180_000,
  });
  await expect(status(sender)).toContainText('The receiver verified every file');
  expect(saved.get(receiver)).toHaveLength(0); // nothing downloaded a second time
  const got = await receiver.evaluate(
    async ({ name, step }) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
      const file = await (await dir.getFileHandle(name)).getFile();
      const out: string[] = [];
      for (let o = 0; o < file.size; o += step) {
        const d = await crypto.subtle.digest(
          'SHA-256',
          await file.slice(o, o + step).arrayBuffer(),
        );
        out.push([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
      }
      return { size: file.size, slices: out };
    },
    { name: f.name, step: SLICE },
  );
  expect(got).toEqual({ size: SIZE, slices: f.slices });
});

test('elsewhere, OPFS staging then an automatic download, byte-exact (P6-01)', async ({
  page,
}, testInfo) => {
  const f = await bigFile(testInfo, 'staged.bin');
  const { sender, receiver, receiverName } = await openTabs(page, {
    before: (p, who) => (who === 'receiver' ? noPicker(p) : Promise.resolve()),
  });
  const incoming = await offer(sender, receiver, receiverName, f.path);
  await expect(incoming).toContainText(/browser's storage first \(.* free\)/);
  await incoming.getByRole('button', { name: 'Accept files' }).click();
  await expect(status(receiver)).toContainText('Every file passed its integrity check', {
    timeout: 180_000,
  });
  const got = saved.get(receiver)!;
  await expect.poll(() => got.length).toBe(1);
  expect(got[0]!.suggestedFilename()).toBe(f.name);
  expect(await hashFile((await got[0]!.path())!)).toBe(f.sha);
  // The finished copy stays (locked) until this page closes; the next start deletes it (D22).
  expect(await staging(receiver)).toHaveLength(1);
});

test('a byte flipped while writing fails the read-back: never completed, nothing saved (P6-02)', async ({
  page,
}, testInfo) => {
  const f = await bigFile(testInfo, 'flipped.bin');
  const { sender, receiver, receiverName } = await openTabs(page, {
    before: async (p, who) => {
      if (who !== 'receiver') return;
      await noPicker(p);
      // Fault injection: the sink corrupts one byte of its third write after the chunk was verified.
      await p.addInitScript(() => {
        const write = FileSystemWritableFileStream.prototype.write;
        let n = 0;
        FileSystemWritableFileStream.prototype.write = function (
          this: FileSystemWritableFileStream,
          arg: FileSystemWriteChunkType,
        ) {
          const params = arg as WriteParams;
          if (++n === 3 && params.type === 'write') {
            const data = new Uint8Array(params.data as Uint8Array).slice();
            data[10]! ^= 1;
            return write.call(this, { ...params, data });
          }
          return write.call(this, arg);
        };
      });
    },
  });
  const incoming = await offer(sender, receiver, receiverName, f.path);
  await incoming.getByRole('button', { name: 'Accept files' }).click();
  await expect(status(receiver)).toContainText('failed its integrity check', { timeout: 180_000 });
  await expect(status(sender)).not.toContainText('verified every file');
  expect(saved.get(receiver)).toHaveLength(0);
  await expect.poll(() => staging(receiver)).toEqual([]); // partial data deleted
  expect((await sent(sender)).payloadBytes).toBeGreaterThan(0);
});

test('a tab closed mid-transfer leaves nothing behind after the next start (P6-06)', async ({
  page,
}, testInfo) => {
  const f = await bigFile(testInfo, 'abandoned.bin');
  const { sender, receiver, receiverName } = await openTabs(page, {
    before: (p, who) => (who === 'receiver' ? noPicker(p) : Promise.resolve()),
  });
  const incoming = await offer(sender, receiver, receiverName, f.path);
  await incoming.getByRole('button', { name: 'Accept files' }).click();
  await receiver.evaluate(async () => {
    while (window.__sent.controls.filter((t) => t === 'ack').length < 30) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  const url = receiver.url();
  expect(await staging(receiver)).toHaveLength(1);
  await receiver.close(); // the tab goes away mid-transfer; its Web Lock is released
  // No close reaches the sender: it pauses when its 30 s ICE recovery window runs out (P6-04).
  await expect(status(sender)).toContainText('Paused', { timeout: 60_000 });

  // Chromium keeps uncommitted bytes in the writer's swap file, so the staged file is empty and
  // the next start deletes the folder without asking.
  const again = await page.context().newPage();
  await again.goto(url);
  await expect.poll(() => staging(again)).toEqual([]);
  await expect(again.getByRole('note')).toHaveCount(0);
});

test('partial data from an earlier visit is reported and can be deleted (P6-06)', async ({
  page,
}) => {
  // Seed what an interrupted commit would leave: a staged file with data and no `done` marker.
  await page.evaluate(async () => {
    const dir = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('zipply-AAAAAAAAAAAAAAAAAAAAAA', { create: true });
    const w = await (await dir.getFileHandle('0', { create: true })).createWritable();
    await w.write(new Uint8Array(3 * 1024 * 1024));
    await w.close();
  });
  await page.reload();
  const note = page.getByRole('note');
  await expect(note).toContainText("3.0 MiB of this browser's storage");
  await expect(note).toContainText('cannot be resumed');
  await note.getByRole('button', { name: 'Delete it' }).click();
  await expect(note).toBeHidden();
  expect(await staging(page)).toEqual([]);
});
