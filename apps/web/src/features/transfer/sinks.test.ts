// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MEMORY_CAP,
  directorySink,
  folderSink,
  leftovers,
  planReceive,
  safeFilename,
  stagingSink,
  type Locks,
} from './sinks';

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const notFound = () => new DOMException('missing', 'NotFoundError');

// Minimal in-memory File System Access directory. Like Chromium, a writable writes to a swap copy
// that replaces the file only on close().
interface FakeDir {
  dir: FileSystemDirectoryHandle;
  files: Map<string, Uint8Array>;
  dirs: Map<string, FakeDir>;
}

function fakeDir(name = 'root', existing: Record<string, number> = {}): FakeDir {
  const files = new Map<string, Uint8Array>(
    Object.entries(existing).map(([n, size]) => [n, new Uint8Array(size)]),
  );
  const dirs = new Map<string, FakeDir>();
  const fileHandle = (fname: string) => ({
    kind: 'file' as const,
    name: fname,
    async createWritable() {
      let swap = new Uint8Array(0);
      return {
        async write(p: { type: 'write'; position: number; data: Uint8Array }) {
          const end = p.position + p.data.length;
          if (end > swap.length) {
            const grown = new Uint8Array(end);
            grown.set(swap);
            swap = grown;
          }
          swap.set(p.data, p.position);
        },
        async truncate(size: number) {
          swap = swap.slice(0, size);
        },
        async close() {
          files.set(fname, swap);
        },
        async abort() {},
      };
    },
    async getFile() {
      return new File([files.get(fname)! as BlobPart], fname);
    },
  });
  const handle = {
    kind: 'directory' as const,
    name,
    async getFileHandle(fname: string, o?: { create?: boolean }) {
      if (!files.has(fname)) {
        if (!o?.create) throw notFound();
        files.set(fname, new Uint8Array(0));
      }
      return fileHandle(fname);
    },
    async getDirectoryHandle(dname: string, o?: { create?: boolean }) {
      if (!dirs.has(dname)) {
        if (!o?.create) throw notFound();
        dirs.set(dname, fakeDir(dname));
      }
      return dirs.get(dname)!.dir;
    },
    async removeEntry(ename: string) {
      if (!files.delete(ename) && !dirs.delete(ename)) throw notFound();
    },
    async *entries() {
      for (const n of files.keys()) yield [n, fileHandle(n)] as const;
      for (const [n, d] of dirs) yield [n, d.dir] as const;
    },
  };
  return { dir: handle as unknown as FileSystemDirectoryHandle, files, dirs };
}

function fakeLocks(held: string[] = []): Locks & { held: Set<string> } {
  const set = new Set(held);
  return {
    held: set,
    async request(name, ...args) {
      const [options, cb] = (args.length === 2 ? args : [{}, args[0]]) as [
        { ifAvailable?: boolean },
        (lock: unknown) => Promise<unknown>,
      ];
      if (set.has(name)) return options.ifAvailable ? cb(null) : new Promise(() => {});
      set.add(name);
      try {
        return await cb({ name });
      } finally {
        set.delete(name);
      }
    },
  };
}

describe('directorySink', () => {
  it('writes each file at its offsets and returns the committed bytes', async () => {
    const { dir } = fakeDir();
    const sink = directorySink(dir, ['0', '1', '2']);
    await sink.write(0, 0, Uint8Array.of(1, 2, 3));
    await sink.write(0, 3, Uint8Array.of(4));
    await sink.write(1, 0, Uint8Array.of(9));
    expect(await bytes(await sink.close(0))).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(await bytes(await sink.close(1))).toEqual(Uint8Array.of(9));
    expect((await sink.close(2)).size).toBe(0); // a zero-byte file is still created
  });

  it('truncate drops the unconfirmed tail before writing continues', async () => {
    const { dir } = fakeDir();
    const sink = directorySink(dir, ['0']);
    await sink.write(0, 0, Uint8Array.of(1, 2, 3, 4));
    await sink.truncate(0, 2);
    await sink.write(0, 2, Uint8Array.of(7));
    expect(await bytes(await sink.close(0))).toEqual(Uint8Array.of(1, 2, 7));
  });

  it('abort deletes the files it created', async () => {
    const { dir, files } = fakeDir('d', { 'keep.txt': 3 });
    const sink = directorySink(dir, ['a', 'b']);
    await sink.write(0, 0, Uint8Array.of(1));
    await sink.close(0);
    await sink.write(1, 0, Uint8Array.of(2));
    await sink.abort();
    expect([...files.keys()]).toEqual(['keep.txt']);
  });
});

describe('folderSink (File System Access, Chromium desktop)', () => {
  it('uses sanitized names and never overwrites an existing file', async () => {
    const { dir, files } = fakeDir('Downloads', { 'a.txt': 5, 'b (1)': 1 });
    const sink = await folderSink(dir, ['a.txt', 'a.txt', '../b', 'b']);
    for (let i = 0; i < 4; i++) {
      await sink.write(i, 0, Uint8Array.of(i));
      await sink.close(i);
    }
    expect(files.get('a.txt')).toHaveLength(5);
    expect([...files.keys()].sort()).toEqual(
      ['a.txt', 'a (1).txt', 'a (2).txt', '_b', 'b', 'b (1)'].sort(),
    );
  });
});

describe('stagingSink and leftovers (OPFS, D22)', () => {
  it('stages under a locked per-transfer folder and marks it done after the last file', async () => {
    const { dir: root, dirs } = fakeDir();
    const locks = fakeLocks();
    const sink = await stagingSink('T1', 2, root, locks);
    expect(locks.held.has('zipply-T1')).toBe(true);
    await sink.write(0, 0, Uint8Array.of(5));
    await sink.close(0);
    expect(dirs.get('zipply-T1')!.files.has('done')).toBe(false);
    await sink.close(1);
    expect(dirs.get('zipply-T1')!.files.has('done')).toBe(true);
  });

  it('abort removes the staging folder and releases the lock', async () => {
    const { dir: root, dirs } = fakeDir();
    const locks = fakeLocks();
    const sink = await stagingSink('T2', 1, root, locks);
    await sink.write(0, 0, Uint8Array.of(5));
    await sink.abort();
    expect(dirs.has('zipply-T2')).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(locks.held.has('zipply-T2')).toBe(false);
  });

  it('deletes finished copies silently, reports partial data, and skips folders in use', async () => {
    const { dir: root, dirs } = fakeDir();
    const make = async (id: string, size: number, done: boolean) => {
      const d = await root.getDirectoryHandle(`zipply-${id}`, { create: true });
      const w = await (await d.getFileHandle('0', { create: true })).createWritable();
      await w.write({ type: 'write', position: 0, data: new Uint8Array(size) });
      await w.close();
      if (done) await d.getFileHandle('done', { create: true });
    };
    await make('done', 10, true);
    await make('partial', 7, false);
    await make('busy', 3, false);
    await make('empty', 0, false); // a closed tab's writer never committed: nothing to report
    await root.getDirectoryHandle('other-app', { create: true });
    const locks = fakeLocks(['zipply-busy']);

    const found = await leftovers(root, locks);
    expect(found.bytes).toBe(7);
    expect([...dirs.keys()].sort()).toEqual(['other-app', 'zipply-busy', 'zipply-partial']);
    await found.remove();
    expect([...dirs.keys()].sort()).toEqual(['other-app', 'zipply-busy']);
  });
});

describe('planReceive (D21)', () => {
  const env = (o: Partial<Parameters<typeof planReceive>[1]> = {}) => ({
    folder: false,
    opfs: false,
    estimate: async () => ({ quota: 10e9, usage: 1e9 }),
    ...o,
  });

  it('keeps small transfers in memory', async () => {
    expect(await planReceive(MEMORY_CAP, env({ folder: true, opfs: true }))).toEqual({
      kind: 'memory',
    });
  });

  it('uses a folder on Chromium desktop, else browser storage, for large transfers', async () => {
    expect(await planReceive(MEMORY_CAP + 1, env({ folder: true, opfs: true }))).toEqual({
      kind: 'folder',
    });
    expect(await planReceive(MEMORY_CAP + 1, env({ opfs: true }))).toEqual({
      kind: 'browser',
      free: 9e9,
    });
  });

  it('rejects when browser storage reports too little space or no sink exists', async () => {
    expect(await planReceive(9e9 + 1, env({ opfs: true }))).toEqual({
      kind: null,
      reason: 'no-space',
      free: 9e9,
    });
    expect(await planReceive(MEMORY_CAP + 1, env())).toEqual({ kind: null, reason: 'no-sink' });
  });

  it('treats an unknown estimate as advisory and allows browser storage', async () => {
    const plan = await planReceive(MEMORY_CAP + 1, env({ opfs: true, estimate: async () => ({}) }));
    expect(plan).toEqual({ kind: 'browser' });
  });
});

describe('safeFilename', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['C:\\Windows\\evil.exe', 'C__Windows_evil.exe'],
    ['a<b>c:d"e|f?g*h', 'a_b_c_d_e_f_g_h'],
    ['photo\u202Egnp.exe', 'photognp.exe'],
    ['bell\u0007\nname.txt', 'bellname.txt'],
    ['  .hidden. ', 'hidden'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['', 'file'],
    ['...', 'file'],
    ['Bücher 📚.txt', 'Bücher 📚.txt'],
  ])('%j → %j', (input, expected) => {
    expect(safeFilename(input)).toBe(expected);
  });

  it('limits length to 200 code points', () => {
    expect([...safeFilename('x'.repeat(500))]).toHaveLength(200);
  });
});
