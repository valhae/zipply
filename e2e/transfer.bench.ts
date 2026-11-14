import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { chromium, expect, test, type Page } from '@playwright/test';
import { connect, openTabs, status, verify } from './webrtc';

// P6-07: chunk size × watermarks, measured on the real session, sender, receiver and frames code
// over a real loopback DataChannel (two RTCPeerConnections in one page, memory sink).
// P6-08: 1 GiB through the real app (two pages, local Worker, folder sink), with peak memory.

const MiB = 1024 * 1024;
const DAY = new Date().toISOString().slice(0, 10);

async function environment(page: Page) {
  return {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    browser: `${page.context().browser()?.browserType().name()} ${page.context().browser()?.version()}`,
    route: 'loopback on one machine (no network)',
  };
}

async function save(name: string, data: unknown) {
  await mkdir('docs/benchmarks', { recursive: true });
  await writeFile(`docs/benchmarks/${name}`, `${JSON.stringify(data, null, 2)}\n`);
}

const MODULES = {
  session: '/src/features/connection/session.ts',
  sas: '/src/features/connection/sas.ts',
  sinks: '/src/features/transfer/sinks.ts',
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test('chunk size × watermarks (P6-07)', async ({ page }) => {
  test.setTimeout(30 * 60_000);
  await page.goto('/');
  const SIZE = 64 * MiB;
  const CHUNKS = (process.env.BENCH_CHUNKS ?? '16,32,64,128,256')
    .split(',')
    .map((k) => Number(k) * 1024);
  const MARKS = [
    [1 * MiB, 256 * 1024],
    [4 * MiB, 1 * MiB],
    [16 * MiB, 4 * MiB],
  ] as const;
  const RUNS = Number(process.env.BENCH_RUNS ?? 3);
  const results = [];
  for (const chunkSize of CHUNKS) {
    for (const [high, low] of MARKS) {
      const runs: { mibPerSecond: number; chunkPayload: number }[] = [];
      for (let r = 0; r < RUNS; r++) {
        runs.push(
          await page.evaluate(
            async ({ size, tuning, urls }) => {
              type Session = {
                getSnapshot(): { say: string[] | null; state: string };
                subscribe(fn: () => void): () => void;
                checkWords(typed: string): string;
                accept(): Promise<void>;
                debug(): { chunkSize: number | null };
                dispose(): void;
              };
              const load = (url: string) => import(/* @vite-ignore */ url);
              const { createSession } = (await load(urls.session)) as {
                createSession: (o: object) => Session;
              };
              const { commit, randomBytes } = (await load(urls.sas)) as {
                commit: (connId: Uint8Array, nO: Uint8Array) => Promise<Uint8Array>;
                randomBytes: (n: number) => Uint8Array;
              };
              const { memorySink } = (await load(urls.sinks)) as { memorySink: () => object };
              const a = new RTCPeerConnection();
              const b = new RTCPeerConnection();
              a.onicecandidate = (e) => void (e.candidate && b.addIceCandidate(e.candidate));
              b.onicecandidate = (e) => void (e.candidate && a.addIceCandidate(e.candidate));
              const da = a.createDataChannel('zipply', { negotiated: true, id: 0, ordered: true });
              const db = b.createDataChannel('zipply', { negotiated: true, id: 0, ordered: true });
              await a.setLocalDescription();
              await b.setRemoteDescription(a.localDescription!);
              await b.setLocalDescription();
              await a.setRemoteDescription(b.localDescription!);
              await new Promise((r) => (da.readyState === 'open' ? r(0) : (da.onopen = r)));
              const connId = randomBytes(16);
              const nO = randomBytes(16);
              const nA = randomBytes(16);
              const cO = await commit(connId, nO);
              const conn = (pc: RTCPeerConnection) => ({
                sdp: () => ({
                  local: pc.currentLocalDescription?.sdp,
                  remote: pc.currentRemoteDescription?.sdp,
                }),
                maxMessageSize: () => pc.sctp?.maxMessageSize,
                onClose: () => pc.close(),
                tuning,
              });
              const data = new Uint8Array(size);
              for (let o = 0; o < size; o += 65_536)
                crypto.getRandomValues(data.subarray(o, o + 65_536));
              const O = createSession({
                ...conn(a),
                role: 'offerer',
                channel: da,
                secrets: { connId, cO, nO, nA },
                files: [new File([data], 'bench.bin')],
              });
              const A = createSession({
                ...conn(b),
                role: 'answerer',
                channel: db,
                secrets: { connId, cO, nA },
                receive: { plan: async () => ({ kind: 'memory' }), open: async () => memorySink() },
              });
              // Polls both sessions (either may change last) and fails loudly instead of hanging.
              const until = async (what: string, ok: () => boolean) => {
                for (const end = performance.now() + 120_000; !ok();) {
                  if (performance.now() > end) {
                    const st = [O, A].map((x) => x.getSnapshot().state).join('/');
                    throw new Error(`timed out waiting for ${what} (${st})`);
                  }
                  await new Promise((r) => setTimeout(r, 20));
                }
              };
              await until(
                'words',
                () => A.getSnapshot().say !== null && O.getSnapshot().say !== null,
              );
              O.checkWords(A.getSnapshot().say!.join(' '));
              A.checkWords(O.getSnapshot().say!.join(' '));
              await until('manifest', () => A.getSnapshot().state === 'offered');
              const t0 = performance.now();
              await A.accept();
              await until('completion', () =>
                ['completed', 'failed'].includes(A.getSnapshot().state),
              );
              const seconds = (performance.now() - t0) / 1000;
              const ok = A.getSnapshot().state === 'completed';
              const chunkPayload = A.debug().chunkSize ?? 0;
              A.dispose();
              O.dispose();
              if (!ok) throw new Error('transfer failed');
              return { mibPerSecond: size / 1048576 / seconds, chunkPayload };
            },
            { size: SIZE, tuning: { chunkSize, high, low }, urls: MODULES },
          ),
        );
      }
      const speeds = runs.map((x) => Number(x.mibPerSecond.toFixed(1)));
      results.push({
        chunkSize,
        chunkPayload: runs[0]!.chunkPayload,
        high,
        low,
        mibPerSecond: speeds,
        median: median(speeds),
      });
      console.log(`[P6-07] chunk ${chunkSize} high ${high} low ${low}: ${speeds.join(', ')} MiB/s`);
    }
  }
  await save(`${DAY}-chunk-watermark-chromium.json`, {
    task: 'P6-07',
    environment: await environment(page),
    sizeBytes: SIZE,
    sink: 'memory',
    runsPerSetting: RUNS,
    results,
  });
});

/** Working set of Playwright's Chromium processes (Windows only); null elsewhere. */
function browserMemory(): number | null {
  if (process.platform !== 'win32') return null;
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' } | Measure-Object WorkingSet64 -Sum).Sum",
    ],
    { encoding: 'utf8' },
  );
  return Number(out.trim()) || null;
}

// A persistent (on-disk) profile: Playwright's default contexts are off the record, where the
// browser's storage quota is small and varies with free memory (a 1 GiB OPFS write hit
// QuotaExceededError there once and passed once). A real picked folder has no such quota.
test('1 GiB through the real app with bounded memory (P6-08)', async ({ baseURL }, testInfo) => {
  test.setTimeout(20 * 60_000);
  const SIZE = 1024 * MiB;
  const path = testInfo.outputPath('one-gib.bin');
  const fh = await open(path, 'w');
  const sha = createHash('sha256');
  const slices: string[] = [];
  for (let o = 0; o < SIZE; o += 16 * MiB) {
    const part = randomBytes(16 * MiB);
    sha.update(part);
    slices.push(createHash('sha256').update(part).digest('hex'));
    await fh.write(part);
  }
  await fh.close();

  const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    baseURL,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/');
  const { sender, receiver, receiverName } = await openTabs(page, {
    before: (p, who) =>
      who === 'receiver'
        ? p.addInitScript(() =>
            Object.defineProperty(window, 'showDirectoryPicker', {
              configurable: true,
              value: async () =>
                (await navigator.storage.getDirectory()).getDirectoryHandle('picked', {
                  create: true,
                }),
            }),
          )
        : Promise.resolve(),
  });
  const heap = async (p: Page) => {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Performance.enable');
    return async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return metrics.find((m) => m.name === 'JSHeapUsedSize')!.value;
    };
  };
  const heapOf = { sender: await heap(sender), receiver: await heap(receiver) };
  const quota = await receiver.evaluate(() => navigator.storage.estimate());
  const baseline = {
    sender: await heapOf.sender(),
    receiver: await heapOf.receiver(),
    browser: browserMemory(),
  };
  await (
    await connect(sender, receiver, receiverName, path)
  )
    .getByRole('button', { name: 'Accept connection' })
    .click();
  await verify(sender, receiver);
  const t0 = Date.now();
  await receiver.getByRole('button', { name: 'Accept files' }).click();

  const peak = { ...baseline };
  let done = false;
  const sampling = (async () => {
    while (!done) {
      peak.sender = Math.max(peak.sender, await heapOf.sender());
      peak.receiver = Math.max(peak.receiver, await heapOf.receiver());
      const b = browserMemory();
      if (b !== null) peak.browser = Math.max(peak.browser ?? 0, b);
      await page.waitForTimeout(1000);
    }
  })();
  await expect(status(receiver)).toContainText('saved in the folder you chose', {
    timeout: 15 * 60_000,
  });
  const seconds = (Date.now() - t0) / 1000;
  done = true;
  await sampling;

  // Byte-exact check, in bounded 16 MiB slices on both sides.
  const received = await receiver.evaluate(async (step) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
    const file = await (await dir.getFileHandle('one-gib.bin')).getFile();
    const out: string[] = [];
    for (let o = 0; o < file.size; o += step) {
      const d = await crypto.subtle.digest('SHA-256', await file.slice(o, o + step).arrayBuffer());
      out.push([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
    return { size: file.size, slices: out };
  }, 16 * MiB);
  expect(received).toEqual({ size: SIZE, slices });
  const heapGrowth = {
    sender: peak.sender - baseline.sender,
    receiver: peak.receiver - baseline.receiver,
  };
  const result = {
    task: 'P6-08',
    environment: await environment(page),
    sizeBytes: SIZE,
    sourceSha256: sha.digest('hex'),
    sink: 'folder (File System Access, picker replaced by an OPFS folder in automation)',
    profile: 'persistent (on disk)',
    reportedQuotaBytes: quota.quota ?? null,
    secondsIncludingReadBack: Number(seconds.toFixed(1)),
    mibPerSecond: Number((1024 / seconds).toFixed(1)),
    jsHeapBytes: { baseline: { sender: baseline.sender, receiver: baseline.receiver }, heapGrowth },
    browserWorkingSetBytes:
      baseline.browser === null ? null : { baseline: baseline.browser, peak: peak.browser },
  };
  console.log(`[P6-08] ${JSON.stringify(result)}`);
  await save(`${DAY}-one-gib-chromium.json`, result);
  await context.close();
  // Bounded memory: the JS heap grows by far less than the file (a whole-file buffer would be 1 GiB).
  expect(heapGrowth.sender).toBeLessThan(64 * MiB);
  expect(heapGrowth.receiver).toBeLessThan(64 * MiB);
});
