import { HEADER_BYTES, parseControl, payloadSize, type Control } from '../transfer/frames';
import { createRate } from '../transfer/progress';
import { ACK_EVERY, createReceiver, type Manifest } from '../transfer/receiver';
import { sendFile } from '../transfer/sender';
import {
  openSink,
  planReceive,
  safeFilename,
  type ReceivePlan,
  type Sink,
} from '../transfer/sinks';
import {
  INITIAL_GATE,
  canSendPayload,
  isTerminal,
  transition,
  type FailReason,
  type Gate,
  type GateEvent,
  type GateState,
} from './gate';
import {
  commit,
  fromB64url,
  parseFingerprints,
  phrase,
  randomBytes,
  sasDigest,
  sha256,
  splitPhrase,
  toB64url,
  wordsMatch,
} from './sas';

/** One RTCPeerConnection's DataChannel and SAS inputs. A paused transfer gets a new one (D4). */
export interface Connection {
  role: 'offerer' | 'answerer';
  channel: RTCDataChannel;
  /** nO is known up front only by the offerer; the answerer learns it from `sas-reveal`. */
  secrets: { connId: Uint8Array; cO: Uint8Array; nA: Uint8Array; nO?: Uint8Array };
  sdp: () => { local?: string; remote?: string };
  maxMessageSize: () => number | undefined;
  /** Called once the DataChannel has closed, to close the RTCPeerConnection. */
  onClose: () => void;
  /** Redacted route details for the opt-in debug panel (P6-07). */
  stats?: () => Promise<{ ice: string; route: string } | null>;
}

/** Chunk size and watermarks are tunable for the benchmark (P6-07); defaults below. */
export interface Tuning {
  chunkSize: number;
  high: number;
  low: number;
  ackEvery: number;
}

export interface SessionOptions extends Connection {
  /** Files to offer (offerer only). */
  files?: File[];
  /** Where received files go (D21); injectable for tests. */
  receive?: {
    plan: (total: number) => Promise<ReceivePlan>;
    open: (plan: ReceivePlan, m: Manifest) => Promise<Sink>;
  };
  tuning?: Partial<Tuning>;
  resumeTtlMs?: number;
}

export interface Progress {
  confirmed: number;
  total: number;
  /** Bytes per second; null until measured. */
  speed: number | null;
  average: number | null;
  /** Seconds left; only while the rate is steady. */
  eta: number | null;
}

export interface Snapshot {
  state: GateState;
  reason?: FailReason;
  /** The three words this device's user reads aloud (D19); the half they must type is never here. */
  say: string[] | null;
  attemptsLeft: number;
  localConfirmed: boolean;
  /** This connection is for a paused transfer: words first, then it continues (D4). */
  resuming: boolean;
  manifest: { files: { name: string; size: number }[]; total: number } | null;
  /** Receiver: where the files would go, decided before Accept (D21). */
  plan: ReceivePlan | null;
  progress: Progress | null;
  /** While paused: when the transfer stops waiting for a new connection (epoch ms). */
  expiresAt: number | null;
  /** `url` is null for files written straight into a folder the user picked. */
  downloads: { name: string; size: number; url: string | null; blob: Blob }[];
}

export type Session = ReturnType<typeof createSession>;

// Defaults until the P6-07 benchmark picks them from data.
export const TUNING: Tuning = {
  chunkSize: 65_536,
  high: 1024 * 1024,
  low: 256 * 1024,
  ackEvery: ACK_EVERY,
};
const CLOSE_GRACE_MS = 3000;
const PROGRESS_MS = 250;
export const WORD_ATTEMPTS = 3;
/** A paused transfer waits this long for a new connection, and takes at most this many (P6-06). */
export const RESUME_TTL_MS = 10 * 60_000;
export const RESUME_ATTEMPTS = 3;

const enc = new TextEncoder();
const sum = (files: { size: number }[]) => files.reduce((n, f) => n + f.size, 0);
const b64 = (bytes: Uint8Array) => toB64url(bytes);

// SD-07: the resume key comes from the verified connection that accepted the files (D and the
// transferId are only ever sent over the DataChannel), so it never travels anywhere itself. Each
// proof also binds the new connection's digest, so it cannot be replayed on another connection.
const resumeKey = (d: string, transferId: string) =>
  sha256(enc.encode('zipply/resume-key/v1'), fromB64url(d)!, fromB64url(transferId)!);
const resumeProof = async (key: Uint8Array, d: string, role: 'O' | 'A') =>
  b64(await sha256(enc.encode('zipply/resume/v1'), key, fromB64url(d)!, enc.encode(role)));

const browserReceive = { plan: (total: number) => planReceive(total), open: openSink };

/**
 * One transfer between two devices, over one DataChannel at a time: SAS reveal/confirm, the
 * manifest, consent and the transfer. Every inbound message is validated and run through the gate;
 * anything unexpected fails closed. If the connection is lost mid-transfer, the transfer pauses
 * (bytes, digests and the resume key stay in memory and the sink) until `attach` brings a new
 * connection, which must pass the word check again before it may continue (D4).
 */
export function createSession(o: SessionOptions) {
  const { role } = o;
  const sender = role === 'offerer';
  const tuning: Tuning = { ...TUNING, ...o.tuning };
  const receive = o.receive ?? browserReceive;
  const ttl = o.resumeTtlMs ?? RESUME_TTL_MS;
  type Live = Connection & { abort: AbortController; closed: boolean; hear: string[] | null };
  let conn: Live;
  let gate: Gate = INITIAL_GATE;
  let snap: Snapshot = {
    state: gate.state,
    say: null,
    attemptsLeft: WORD_ATTEMPTS,
    localConfirmed: false,
    resuming: false,
    manifest: null,
    plan: null,
    progress: null,
    expiresAt: null,
    downloads: [],
  };
  const listeners = new Set<() => void>();
  // One queue for every connection, so a chunk from a lost one finishes before a resume starts.
  let inbox: Promise<unknown> = Promise.resolve();

  // The transfer: kept across connections while paused.
  let manifest: Manifest | null = null;
  let receiver: ReturnType<typeof createReceiver> | null = null;
  let key: Uint8Array | null = null;
  const digests: Uint8Array[][] = []; // sender: chunk digests per file, for a resume
  let sending = 0; // sender: index of the file being sent
  let queued = 0; // sender: payload bytes handed to the channel
  let confirmed = 0;
  let total = 0;
  let attempts = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const rate = createRate();

  const update = (patch: Partial<Snapshot>) => {
    snap = {
      ...snap,
      ...patch,
      state: gate.state,
      reason: gate.reason,
      localConfirmed: gate.localConfirmed,
      resuming:
        gate.manifestDigest !== null &&
        ['connecting', 'verifying', 'verified'].includes(gate.state),
    };
    listeners.forEach((fn) => fn());
  };

  const progressNow = () =>
    update({ progress: { confirmed, total, ...rate.stats(total - confirmed) } });
  /** P6-09: progress reaches the UI at most every 250 ms, never once per chunk. */
  function progress(bytes: number) {
    confirmed = bytes;
    rate.add(bytes);
    progressTimer ??= setTimeout(() => {
      progressTimer = undefined;
      if (!isTerminal(gate)) progressNow();
    }, PROGRESS_MS);
  }

  const fingerprintKey = () => {
    const { local = '', remote = '' } = conn.sdp();
    const l = parseFingerprints(local);
    const r = parseFingerprints(remote);
    return l && r ? [...l, ...r].map(toB64url).join('.') : '';
  };

  const sendControl = (msg: Control) => {
    if (conn.channel.readyState === 'open') conn.channel.send(JSON.stringify(msg));
  };

  // SD-02 step 8: purge the nonces, commitment and digest; a retry needs a new connection.
  function closeConnection() {
    const c = conn;
    c.abort.abort();
    for (const k of ['nO', 'nA', 'cO'] as const) c.secrets[k]?.fill(0);
    c.hear = null;
    if (c.closed) return;
    c.closed = true;
    c.channel.close();
    // ponytail: fixed grace for queued messages; close earlier on the channel's close event.
    setTimeout(c.onClose, CLOSE_GRACE_MS);
  }

  function pause() {
    closeConnection();
    rate.reset();
    clearTimeout(expiry);
    if (attempts >= RESUME_ATTEMPTS) return void fail('expired');
    expiry = setTimeout(() => {
      if (gate.state !== 'paused') dispatch({ type: 'lost' });
      fail('expired');
    }, ttl);
    update({
      say: null,
      expiresAt: Date.now() + ttl,
      progress: snap.progress && { ...snap.progress, speed: null, eta: null },
    });
  }

  function finish() {
    closeConnection();
    clearTimeout(expiry);
    clearTimeout(progressTimer);
    gate = { ...gate, d: null, fp: null, manifestDigest: null };
    key?.fill(0);
    // SD-04: cancel and failure delete partial data; only a verified, completed transfer is kept.
    if (gate.state !== 'completed') void receiver?.abort();
    update({ say: null, expiresAt: null });
  }

  /** Applies an event; returns true when it led to `expected`. */
  function dispatch(e: GateEvent, expected?: GateState): boolean {
    const before = gate.state;
    gate = transition(gate, e);
    update({});
    if (isTerminal(gate)) finish();
    else if (gate.state === 'paused' && before !== 'paused') pause();
    return expected === undefined || gate.state === expected;
  }

  const fail = (reason: FailReason) => dispatch({ type: 'fail', reason });

  async function computeSas() {
    const { local = '', remote = '' } = conn.sdp();
    const mine = parseFingerprints(local);
    const theirs = parseFingerprints(remote);
    const { nO } = conn.secrets;
    if (!mine || !theirs || !nO) return fail('fingerprint');
    const [fpO, fpA] = sender ? [mine, theirs] : [theirs, mine];
    const d = await sasDigest({
      connId: conn.secrets.connId,
      cO: conn.secrets.cO,
      nO,
      nA: conn.secrets.nA,
      fpO,
      fpA,
    });
    if (dispatch({ type: 'sas-ready', d: toB64url(d), fp: fingerprintKey() }, 'verifying')) {
      const words = splitPhrase(phrase(d), role);
      conn.hear = words.hear;
      update({ say: words.say });
    }
  }

  /** Sender, once both words checks passed: a manifest on the first connection, else a resume. */
  async function next() {
    if (gate.manifestDigest !== null) {
      if (!key) return void fail('protocol');
      sendControl({
        v: 1,
        t: 'resume',
        transferId: manifest!.transferId,
        proof: await resumeProof(key!, gate.d!, 'O'),
      });
      return;
    }
    const files = o.files ?? [];
    const msg: Control = {
      v: 1,
      t: 'manifest',
      transferId: toB64url(randomBytes(16)),
      chunkSize: payloadSize(conn.maxMessageSize(), tuning.chunkSize),
      files: files.map((f) => ({
        name: f.name.slice(0, 1024),
        size: f.size,
        type: f.type.slice(0, 255),
      })),
    };
    const text = JSON.stringify(msg);
    const digest = toB64url(await sha256(enc.encode(text)));
    if (!dispatch({ type: 'manifest', digest, fp: fingerprintKey() }, 'offered')) return;
    manifest = msg;
    total = sum(files);
    update({ progress: { confirmed: 0, total, speed: null, average: null, eta: null } });
    conn.channel.send(text);
  }

  /** Sender: streams from a position confirmed by the receiver (0/0 for a new transfer). */
  async function sendAll(from: { fileIdx: number; offset: number }) {
    if (!manifest || !o.files) return;
    const live = conn;
    const { transferId, chunkSize } = manifest;
    const files = o.files;
    const sendPayload = (frame: ArrayBuffer) => {
      if (!canSendPayload(gate) || conn !== live) throw new Error('Payload not allowed now');
      live.channel.send(frame);
      queued += frame.byteLength - HEADER_BYTES;
    };
    queued = sum(files.slice(0, from.fileIdx)) + from.offset;
    try {
      for (let i = from.fileIdx; i < files.length; i++) {
        sending = i;
        const offset = i === from.fileIdx ? from.offset : 0;
        const done = (digests[i] = (digests[i] ?? []).slice(0, Math.ceil(offset / chunkSize)));
        const root = await sendFile(files[i]!, {
          channel: live.channel,
          send: sendPayload,
          fileIdx: i,
          transferId,
          chunkSize,
          high: tuning.high,
          low: tuning.low,
          signal: live.abort.signal,
          offset,
          digests: done,
        });
        if (!canSendPayload(gate) || conn !== live) return;
        sendControl({ v: 1, t: 'file-end', transferId, fileIdx: i, root });
      }
    } catch {
      if (conn !== live || gate.state !== 'transferring') return;
      // A dead channel pauses the transfer; a file that cannot be read fails it.
      if (live.channel.readyState === 'open') fail('closed');
      else dispatch({ type: 'lost' });
    }
  }

  /** Sender: the receiver cannot have confirmed more than was sent, and only whole chunks. */
  function validResume(fileIdx: number, offset: number) {
    const file = o.files?.[fileIdx];
    const chunk = manifest!.chunkSize;
    if (!file || offset > file.size || (offset % chunk !== 0 && offset !== file.size)) return false;
    return fileIdx < sending || Math.ceil(offset / chunk) <= (digests[fileIdx]?.length ?? 0);
  }

  async function onControl(msg: Control, raw: string) {
    const ownTransfer = (id: string) => manifest !== null && id === manifest.transferId;
    switch (msg.t) {
      case 'sas-reveal': {
        const nO = fromB64url(msg.nO)!;
        if (sender || conn.secrets.nO || gate.state !== 'verifying') return fail('protocol');
        const expected = await commit(conn.secrets.connId, nO);
        if (toB64url(expected) !== toB64url(conn.secrets.cO)) return fail('commitment');
        conn.secrets.nO = nO;
        return computeSas();
      }
      case 'sas-confirm':
        dispatch({ type: 'remote-confirm', d: msg.d });
        if (sender && gate.state === 'verified') await next();
        return;
      case 'manifest': {
        if (sender) return fail('protocol');
        const digest = toB64url(await sha256(enc.encode(raw)));
        if (!dispatch({ type: 'manifest', digest, fp: fingerprintKey() }, 'offered')) return;
        manifest = msg;
        total = sum(msg.files);
        const files = msg.files.map((f) => ({ name: safeFilename(f.name), size: f.size }));
        const plan = await receive.plan(total);
        update({
          manifest: { files, total },
          plan,
          progress: { confirmed: 0, total, speed: null, average: null, eta: null },
        });
        if (plan.kind === null) reject();
        return;
      }
      case 'files-accept': {
        if (!sender || !ownTransfer(msg.transferId)) return fail('protocol');
        const d = gate.d!;
        const accept = {
          type: 'accept',
          digest: msg.manifestDigest,
          fp: fingerprintKey(),
        } as const;
        if (!dispatch(accept, 'transferring')) return;
        key = await resumeKey(d, msg.transferId);
        void sendAll({ fileIdx: 0, offset: 0 });
        return;
      }
      case 'files-reject':
        if (!sender || !ownTransfer(msg.transferId)) return fail('protocol');
        dispatch({ type: 'reject' });
        return;
      case 'resume': {
        if (sender || !receiver || !key || !ownTransfer(msg.transferId)) return fail('protocol');
        if (gate.state !== 'verified' || msg.proof !== (await resumeProof(key, gate.d!, 'O'))) {
          return fail('protocol');
        }
        const proof = await resumeProof(key, gate.d!, 'A');
        const at = await receiver.rewind();
        if (!dispatch({ type: 'resume', fp: fingerprintKey() }, 'transferring')) return;
        attempts = 0;
        clearTimeout(expiry);
        update({ expiresAt: null });
        sendControl({ v: 1, t: 'resume-from', transferId: msg.transferId, ...at, proof });
        progress(receiver.confirmed);
        return;
      }
      case 'resume-from': {
        if (!sender || !key || !ownTransfer(msg.transferId)) return fail('protocol');
        if (gate.state !== 'verified' || msg.proof !== (await resumeProof(key, gate.d!, 'A'))) {
          return fail('protocol');
        }
        if (!validResume(msg.fileIdx, msg.offset)) return fail('protocol');
        if (!dispatch({ type: 'resume', fp: fingerprintKey() }, 'transferring')) return;
        attempts = 0;
        clearTimeout(expiry);
        update({ expiresAt: null });
        void sendAll(msg);
        return;
      }
      case 'ack':
        if (!sender || !ownTransfer(msg.transferId) || gate.state !== 'transferring')
          return fail('protocol');
        // P6-03: confirmed never exceeds what was actually handed to the channel.
        if (msg.bytes > total || msg.bytes > queued) return fail('protocol');
        progress(msg.bytes);
        return;
      case 'complete':
        if (!sender || !ownTransfer(msg.transferId)) return fail('protocol');
        confirmed = total;
        progressNow();
        dispatch({ type: 'complete' });
        return;
      case 'file-end': {
        if (sender || !receiver || !ownTransfer(msg.transferId) || !canSendPayload(gate)) {
          return fail('protocol');
        }
        const result = await receiver.fileEnd(msg.fileIdx, msg.root);
        if (!result.ok) return fail(result.reason);
        sendControl({ v: 1, t: 'ack', transferId: msg.transferId, bytes: receiver.confirmed });
        progress(receiver.confirmed);
        if (receiver.done) finishReceive();
        return;
      }
      case 'cancel':
        dispatch({ type: 'cancel' });
        return;
    }
  }

  function finishReceive() {
    if (!manifest || !receiver) return;
    const files = manifest.files;
    const folder = snap.plan?.kind === 'folder';
    const downloads = receiver.blobs.map((blob, i) => ({
      name: safeFilename(files[i]!.name),
      size: blob.size,
      blob,
      url: folder ? null : URL.createObjectURL(blob),
    }));
    sendControl({ v: 1, t: 'complete', transferId: manifest.transferId });
    confirmed = total;
    progressNow();
    update({ downloads });
    dispatch({ type: 'complete' });
  }

  async function onPayload(frame: ArrayBuffer) {
    // SD-03: payload outside the transferring state is a violation and closes the connection.
    if (!receiver || !manifest || !canSendPayload(gate)) return fail('protocol');
    const result = await receiver.chunk(frame);
    if (!result.ok) return fail(result.reason);
    if (result.ack) {
      sendControl({ v: 1, t: 'ack', transferId: manifest.transferId, bytes: receiver.confirmed });
    }
    progress(receiver.confirmed);
  }

  async function onMessage(data: unknown) {
    if (isTerminal(gate) || gate.state === 'paused') return;
    if (data instanceof ArrayBuffer) return onPayload(data);
    const msg = typeof data === 'string' ? parseControl(data) : null;
    if (!msg) return fail('protocol');
    return onControl(msg, data as string);
  }

  function bind(c: Connection) {
    const live: Live = {
      ...c,
      secrets: { ...c.secrets },
      abort: new AbortController(),
      closed: false,
      hear: null,
    };
    conn = live;
    const current = () => conn === live && !isTerminal(gate);
    const onOpen = () => {
      if (!current() || !dispatch({ type: 'open' }, 'verifying')) return;
      if (sender && live.secrets.nO) {
        sendControl({ v: 1, t: 'sas-reveal', nO: toB64url(live.secrets.nO) });
        inbox = inbox.then(() => current() && computeSas());
      }
    };
    live.channel.binaryType = 'arraybuffer';
    live.channel.addEventListener('message', (e) => {
      const { data } = e as MessageEvent;
      inbox = inbox
        .then(() => (current() ? onMessage(data) : undefined))
        .catch(() => void (current() && fail('protocol')));
    });
    live.channel.addEventListener('close', () => {
      if (current() && gate.state !== 'paused') dispatch({ type: 'lost' });
      live.closed = true;
      live.onClose();
    });
    if (live.channel.readyState === 'open') onOpen();
    else live.channel.addEventListener('open', onOpen);
  }

  function reject() {
    if (sender || !manifest || gate.state !== 'offered') return;
    // Send before the terminal transition, which closes the channel.
    sendControl({ v: 1, t: 'files-reject', transferId: manifest.transferId });
    dispatch({ type: 'reject' });
  }

  bind(o);

  return {
    role,
    getSnapshot: () => snap,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /**
     * A new connection for this paused transfer (P6-05). It starts at the word check (D4); the
     * transfer continues only after both checks pass and the resume proofs match. Returns false if
     * the transfer is not paused or has used up its attempts.
     */
    attach(c: Connection): boolean {
      if (gate.state !== 'paused' || c.role !== role || attempts >= RESUME_ATTEMPTS) return false;
      attempts++;
      dispatch({ type: 'reattach' });
      update({ attemptsLeft: WORD_ATTEMPTS, say: null });
      bind(c);
      return true;
    },
    /**
     * Local user action only (D19): the words this user heard from the other person. Checked here
     * and never sent; the third wrong entry fails closed as a mismatch.
     */
    checkWords(typed: string): 'ok' | 'wrong' | 'failed' | 'ignored' {
      if (gate.state !== 'verifying' || gate.d === null || !conn.hear || gate.localConfirmed) {
        return 'ignored';
      }
      if (!wordsMatch(typed, conn.hear)) {
        const attemptsLeft = snap.attemptsLeft - 1;
        update({ attemptsLeft });
        if (attemptsLeft > 0) return 'wrong';
        fail('mismatch');
        return 'failed';
      }
      const d = gate.d;
      const verified = dispatch({ type: 'local-confirm' }, 'verified');
      sendControl({ v: 1, t: 'sas-confirm', d });
      if (sender && verified) void next();
      return 'ok';
    },
    mismatch: () => void fail('mismatch'),
    /** The peer connection failed or timed out: a transfer in progress pauses. */
    lost() {
      if (!isTerminal(gate) && gate.state !== 'paused') dispatch({ type: 'lost' });
    },
    /** Local user action: accept the files. A folder sink asks for the folder first (D21). */
    async accept() {
      const plan = snap.plan;
      if (sender || !manifest || gate.state !== 'offered' || !plan?.kind) return;
      let sink: Sink;
      try {
        sink = await receive.open(plan, manifest);
      } catch (e) {
        if ((e as DOMException | null)?.name === 'AbortError') return; // the user closed the picker
        return void fail('storage');
      }
      if (gate.state !== 'offered') return void sink.abort();
      const { transferId } = manifest;
      const manifestDigest = gate.manifestDigest!;
      const d = gate.d!;
      receiver = createReceiver(manifest, sink, tuning.ackEvery);
      if (
        dispatch({ type: 'accept', digest: manifestDigest, fp: fingerprintKey() }, 'transferring')
      ) {
        sendControl({ v: 1, t: 'files-accept', transferId, manifestDigest });
        key = await resumeKey(d, transferId);
      }
    },
    reject,
    cancel() {
      if (isTerminal(gate)) return;
      sendControl({ v: 1, t: 'cancel' });
      dispatch({ type: 'cancel' });
    },
    /** Opt-in debug panel (P6-07): sizes and counters only; no names, SDP, ICE or addresses. */
    debug() {
      return {
        role,
        state: gate.state,
        chunkSize: manifest?.chunkSize ?? null,
        maxMessageSize: conn.maxMessageSize() ?? null,
        high: tuning.high,
        low: tuning.low,
        ackEvery: tuning.ackEvery,
        bufferedAmount: conn.channel.readyState === 'open' ? conn.channel.bufferedAmount : 0,
        queued: sender ? queued : null,
        confirmed: sender ? confirmed : (receiver?.confirmed ?? 0),
        total,
        stats: conn.stats,
      };
    },
    /** Releases object URLs and closes the connection. */
    dispose() {
      if (!isTerminal(gate)) this.cancel();
      snap.downloads.forEach((d) => d.url && URL.revokeObjectURL(d.url));
    },
  };
}
