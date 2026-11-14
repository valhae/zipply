/**
 * Where received bytes go (P6-01). Calls are sequential per receiver; only verified chunks are
 * written, and a file is offered only after `close` and the receiver's read-back (SD-06).
 */
export interface Sink {
  write(fileIdx: number, offset: number, data: Uint8Array): Promise<void>;
  /** Drops everything of file `fileIdx` after `size` bytes (the unconfirmed tail on resume). */
  truncate(fileIdx: number, size: number): Promise<void>;
  /** Commits file `fileIdx` and returns the stored bytes for read-back and saving. */
  close(fileIdx: number): Promise<Blob>;
  /** Deletes partial and stored data (cancel, failure). */
  abort(): Promise<void>;
}

/** Holds received bytes in memory; only for transfers up to the memory cap (D21). */
export function memorySink(): Sink {
  const files = new Map<number, Uint8Array[]>();
  return {
    async write(fileIdx, offset, data) {
      const parts = files.get(fileIdx) ?? [];
      const size = parts.reduce((n, p) => n + p.length, 0);
      if (offset !== size) throw new Error('Out-of-order write');
      parts.push(data.slice());
      files.set(fileIdx, parts);
    },
    async truncate(fileIdx, size) {
      const kept: Uint8Array[] = [];
      let n = 0;
      for (const p of files.get(fileIdx) ?? []) {
        if (n >= size) break;
        kept.push(p.subarray(0, size - n));
        n += Math.min(p.length, size - n);
      }
      files.set(fileIdx, kept);
    },
    async close(fileIdx) {
      const blob = new Blob((files.get(fileIdx) ?? []) as BlobPart[], {
        type: 'application/octet-stream',
      });
      files.delete(fileIdx);
      return blob;
    },
    async abort() {
      files.clear();
    },
  };
}

/** Receive cap for the memory sink (owner decision D21). */
export const MEMORY_CAP = 256 * 1024 * 1024;
const STAGING = 'zipply-';
const DONE = 'done';

/** The subset of `navigator.locks` used here; injectable for tests. */
export interface Locks {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

type PickerWindow = {
  showDirectoryPicker?: (o: {
    mode: 'readwrite';
    id: string;
    startIn: string;
  }) => Promise<FileSystemDirectoryHandle>;
};

/** File System Access folder picker (Chromium desktop); must run inside the user's click. */
export const pickFolder = () =>
  (window as PickerWindow).showDirectoryPicker!({
    mode: 'readwrite',
    id: 'zipply',
    startIn: 'downloads',
  });

/** Writes file `i` of the transfer to `names[i]` in `dir`; abort deletes what it created. */
export function directorySink(dir: FileSystemDirectoryHandle, names: string[]): Sink {
  type Open = { handle: FileSystemFileHandle; writable: FileSystemWritableFileStream };
  const open = new Map<number, Open>();
  const created = new Set<string>();
  async function file(i: number) {
    let f = open.get(i);
    if (!f) {
      const handle = await dir.getFileHandle(names[i]!, { create: true });
      created.add(names[i]!);
      f = { handle, writable: await handle.createWritable() };
      open.set(i, f);
    }
    return f;
  }
  return {
    async write(i, position, data) {
      await (
        await file(i)
      ).writable.write({
        type: 'write',
        position,
        data: data as Uint8Array<ArrayBuffer>,
      });
    },
    async truncate(i, size) {
      await (await file(i)).writable.truncate(size);
    },
    async close(i) {
      const f = await file(i);
      open.delete(i);
      await f.writable.close();
      return f.handle.getFile();
    },
    async abort() {
      for (const f of open.values()) await f.writable.abort().catch(() => {});
      open.clear();
      for (const name of created) await dir.removeEntry(name).catch(() => {});
      created.clear();
    },
  };
}

const exists = (dir: FileSystemDirectoryHandle, name: string) =>
  dir.getFileHandle(name).then(
    () => true,
    (e: unknown) => (e as DOMException | null)?.name !== 'NotFoundError',
  );

/** A folder the user picked: sanitized names, and "name (1).ext" instead of overwriting anything. */
export async function folderSink(dir: FileSystemDirectoryHandle, rawNames: string[]) {
  const taken = new Set<string>();
  const names: string[] = [];
  for (const raw of rawNames) {
    const base = safeFilename(raw);
    const dot = base.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
    let name = base;
    for (let n = 1; taken.has(name.toLowerCase()) || (await exists(dir, name)); n++) {
      name = `${stem} (${n})${ext}`;
    }
    taken.add(name.toLowerCase());
    names.push(name);
  }
  return directorySink(dir, names);
}

/**
 * OPFS staging for one transfer, in `zipply-<transferId>` with files named by index (no file names
 * on disk). A Web Lock is held while this page uses it, so cleanup in another tab skips it; a
 * `done` marker after the last file lets the next start delete the finished copy silently (D22).
 */
export async function stagingSink(
  transferId: string,
  count: number,
  root?: FileSystemDirectoryHandle,
  locks: Locks = navigator.locks,
): Promise<Sink> {
  const base = root ?? (await navigator.storage.getDirectory());
  const name = STAGING + transferId;
  let release = () => {};
  await new Promise<void>((granted) => {
    void locks.request(name, {}, () => {
      granted();
      return new Promise<void>((r) => (release = r));
    });
  });
  const dir = await base.getDirectoryHandle(name, { create: true });
  const inner = directorySink(
    dir,
    Array.from({ length: count }, (_, i) => String(i)),
  );
  let closed = 0;
  return {
    ...inner,
    async close(i) {
      const f = await inner.close(i);
      if (++closed === count) await dir.getFileHandle(DONE, { create: true });
      return f;
    },
    async abort() {
      await inner.abort();
      await base.removeEntry(name, { recursive: true }).catch(() => {});
      release();
    },
  };
}

/** Staged data left by earlier visits (D22): finished or empty copies are deleted, partial bytes reported. */
export async function leftovers(root?: FileSystemDirectoryHandle, locks: Locks = navigator.locks) {
  const base = root ?? (await navigator.storage.getDirectory());
  const names: string[] = [];
  for await (const [name, handle] of base.entries()) {
    if (name.startsWith(STAGING) && handle.kind === 'directory') names.push(name);
  }
  const partial: string[] = [];
  let bytes = 0;
  for (const name of names) {
    await locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return; // another open tab is using it
      const dir = await base.getDirectoryHandle(name);
      let size = 0;
      let done = false;
      for await (const [n, h] of dir.entries()) {
        if (n === DONE) done = true;
        else if (h.kind === 'file') size += (await (h as FileSystemFileHandle).getFile()).size;
      }
      // Finished, or empty (an uncommitted writer keeps its bytes in the browser's swap file).
      if (done || size === 0) await base.removeEntry(name, { recursive: true }).catch(() => {});
      else {
        partial.push(name);
        bytes += size;
      }
    });
  }
  return {
    bytes,
    async remove() {
      for (const name of partial) {
        await locks.request(name, { ifAvailable: true }, async (lock) => {
          if (lock) await base.removeEntry(name, { recursive: true }).catch(() => {});
        });
      }
    },
  };
}

export type ReceivePlan =
  | { kind: 'memory' | 'folder' }
  | { kind: 'browser'; free?: number }
  | { kind: null; reason: 'no-sink' | 'no-space'; free?: number };

interface ReceiveEnv {
  folder: boolean;
  opfs: boolean;
  estimate: () => Promise<{ quota?: number; usage?: number }>;
}

const browserEnv = (): ReceiveEnv => ({
  folder: typeof (window as PickerWindow).showDirectoryPicker === 'function',
  opfs:
    typeof navigator.storage?.getDirectory === 'function' &&
    'locks' in navigator &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype,
  estimate: () => navigator.storage?.estimate?.() ?? Promise.resolve({}),
});

/**
 * Where a transfer of `total` bytes can be received (D21), decided before Accept. The storage
 * estimate is advisory: quota can still change during the transfer, and a failed write stops it.
 */
export async function planReceive(total: number, env = browserEnv()): Promise<ReceivePlan> {
  if (total <= MEMORY_CAP) return { kind: 'memory' };
  if (env.folder) return { kind: 'folder' };
  if (!env.opfs) return { kind: null, reason: 'no-sink' };
  const { quota, usage } = await env
    .estimate()
    .catch(() => ({}) as { quota?: number; usage?: number });
  if (quota === undefined || usage === undefined) return { kind: 'browser' };
  const free = quota - usage;
  return free < total ? { kind: null, reason: 'no-space', free } : { kind: 'browser', free };
}

/** Opens the sink a plan chose; a folder asks the user first, so call this from their click. */
export async function openSink(
  plan: ReceivePlan,
  m: { transferId: string; files: { name: string }[] },
): Promise<Sink> {
  if (plan.kind === 'folder')
    return folderSink(
      await pickFolder(),
      m.files.map((f) => f.name),
    );
  if (plan.kind === 'browser') return stagingSink(m.transferId, m.files.length);
  return memorySink();
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name safe to show and to suggest for download: no paths, controls, bidi tricks or device names. */
export function safeFilename(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const short = [...cleaned].slice(0, 200).join('');
  if (!short) return 'file';
  return RESERVED.test(short) ? `_${short}` : short;
}
