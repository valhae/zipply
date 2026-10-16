import { parseControl, payloadSize, type Control } from '../transfer/frames';
import {
  DEFAULT_RECEIVE_CAP,
  createReceiver,
  exceedsCap,
  safeFilename,
  type Manifest,
} from '../transfer/receiver';
import { sendFile } from '../transfer/sender';
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
  toB64url,
} from './sas';

export interface SessionOptions {
  role: 'offerer' | 'answerer';
  channel: RTCDataChannel;
  /** nO is known up front only by the offerer; the answerer learns it from `sas-reveal`. */
  secrets: { connId: Uint8Array; cO: Uint8Array; nA: Uint8Array; nO?: Uint8Array };
  sdp: () => { local?: string; remote?: string };
  maxMessageSize: () => number | undefined;
  /** Files to offer (offerer only). */
  files?: File[];
  receiveCap?: number;
  /** Called once the DataChannel has closed, to close the RTCPeerConnection. */
  onClose: () => void;
}

export interface Snapshot {
  state: GateState;
  reason?: FailReason;
  phrase: string[] | null;
  localConfirmed: boolean;
  manifest: { files: { name: string; size: number }[]; total: number } | null;
  tooLarge: boolean;
  progress: { confirmed: number; total: number } | null;
  downloads: { name: string; size: number; url: string; blob: Blob }[];
}

export type Session = ReturnType<typeof createSession>;

// Defaults until the P6 benchmark picks them from data.
const HIGH_WATERMARK = 1024 * 1024;
const LOW_WATERMARK = 256 * 1024;
const CLOSE_GRACE_MS = 3000;

const enc = new TextEncoder();
const sum = (files: { size: number }[]) => files.reduce((n, f) => n + f.size, 0);

/**
 * The DataChannel side of one connection: SAS reveal/confirm, the manifest, consent and the transfer.
 * Every inbound message is validated and run through the gate; anything unexpected fails closed and
 * closes the connection. One transfer per connection; a new attempt needs a new connection.
 */
export function createSession(o: SessionOptions) {
  const { channel } = o;
  const secrets = { ...o.secrets };
  let gate: Gate = INITIAL_GATE;
  let snap: Snapshot = {
    state: gate.state,
    phrase: null,
    localConfirmed: false,
    manifest: null,
    tooLarge: false,
    progress: null,
    downloads: [],
  };
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  let manifest: Manifest | null = null;
  let receiver: ReturnType<typeof createReceiver> | null = null;
  let inbox: Promise<unknown> = Promise.resolve();
  let closed = false;

  const update = (patch: Partial<Snapshot>) => {
    snap = {
      ...snap,
      ...patch,
      state: gate.state,
      reason: gate.reason,
      localConfirmed: gate.localConfirmed,
    };
    listeners.forEach((fn) => fn());
  };

  const fingerprintKey = () => {
    const { local = '', remote = '' } = o.sdp();
    const l = parseFingerprints(local);
    const r = parseFingerprints(remote);
    return l && r ? [...l, ...r].map(toB64url).join('.') : '';
  };

  const sendControl = (msg: Control) => {
    if (channel.readyState === 'open') channel.send(JSON.stringify(msg));
  };

  // SD-02 step 8: purge the nonces, commitment and digest; a retry needs a new connection.
  function teardown() {
    abort.abort();
    for (const key of ['nO', 'nA', 'cO'] as const) secrets[key]?.fill(0);
    gate = { ...gate, d: null, fp: null, manifestDigest: null };
    update({ phrase: null });
    if (closed) return;
    closed = true;
    channel.close();
    // ponytail: fixed grace for queued messages; close earlier on the channel's close event.
    setTimeout(o.onClose, CLOSE_GRACE_MS);
  }

  /** Applies an event; returns true when it led to `expected`. A terminal result tears down. */
  function dispatch(e: GateEvent, expected?: GateState): boolean {
    gate = transition(gate, e);
    update({});
    if (isTerminal(gate)) teardown();
    return expected === undefined || gate.state === expected;
  }

  const fail = (reason: FailReason) => dispatch({ type: 'fail', reason });

  async function computeSas() {
    const { local = '', remote = '' } = o.sdp();
    const mine = parseFingerprints(local);
    const theirs = parseFingerprints(remote);
    const { nO } = secrets;
    if (!mine || !theirs || !nO) return fail('fingerprint');
    const [fpO, fpA] = o.role === 'offerer' ? [mine, theirs] : [theirs, mine];
    const d = await sasDigest({
      connId: secrets.connId,
      cO: secrets.cO,
      nO,
      nA: secrets.nA,
      fpO,
      fpA,
    });
    if (dispatch({ type: 'sas-ready', d: toB64url(d), fp: fingerprintKey() }, 'verifying')) {
      update({ phrase: phrase(d) });
    }
  }

  async function sendManifest() {
    const files = o.files ?? [];
    const transferId = toB64url(randomBytes(16));
    const msg: Control = {
      v: 1,
      t: 'manifest',
      transferId,
      chunkSize: payloadSize(o.maxMessageSize()),
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
    update({ progress: { confirmed: 0, total: sum(files) } });
    channel.send(text);
  }

  async function sendAll() {
    if (!manifest || !o.files) return;
    const sendPayload = (frame: ArrayBuffer) => {
      if (!canSendPayload(gate)) throw new Error('Payload not allowed in this state');
      channel.send(frame);
    };
    try {
      for (const [fileIdx, file] of o.files.entries()) {
        const root = await sendFile(file, {
          channel,
          send: sendPayload,
          fileIdx,
          transferId: manifest.transferId,
          chunkSize: manifest.chunkSize,
          high: HIGH_WATERMARK,
          low: LOW_WATERMARK,
          signal: abort.signal,
        });
        if (!canSendPayload(gate)) return;
        sendControl({ v: 1, t: 'file-end', transferId: manifest.transferId, fileIdx, root });
      }
    } catch {
      if (!isTerminal(gate)) fail('closed');
    }
  }

  async function onControl(msg: Control, raw: string) {
    const sender = o.role === 'offerer';
    const ownTransfer = (id: string) => manifest !== null && id === manifest.transferId;
    switch (msg.t) {
      case 'sas-reveal': {
        const nO = fromB64url(msg.nO)!;
        if (sender || secrets.nO || gate.state !== 'verifying') return fail('protocol');
        const expected = await commit(secrets.connId, nO);
        if (toB64url(expected) !== toB64url(secrets.cO)) return fail('commitment');
        secrets.nO = nO;
        return computeSas();
      }
      case 'sas-confirm':
        dispatch({ type: 'remote-confirm', d: msg.d });
        if (sender && gate.state === 'verified') await sendManifest();
        return;
      case 'manifest': {
        if (sender) return fail('protocol');
        const digest = toB64url(await sha256(enc.encode(raw)));
        if (!dispatch({ type: 'manifest', digest, fp: fingerprintKey() }, 'offered')) return;
        manifest = msg;
        const files = msg.files.map((f) => ({ name: safeFilename(f.name), size: f.size }));
        const tooLarge = exceedsCap(msg, o.receiveCap ?? DEFAULT_RECEIVE_CAP);
        update({
          manifest: { files, total: sum(files) },
          tooLarge,
          progress: { confirmed: 0, total: sum(files) },
        });
        if (tooLarge) reject();
        return;
      }
      case 'files-accept':
        if (!sender || !ownTransfer(msg.transferId)) return fail('protocol');
        if (
          dispatch(
            { type: 'accept', digest: msg.manifestDigest, fp: fingerprintKey() },
            'transferring',
          )
        ) {
          void sendAll();
        }
        return;
      case 'files-reject':
        if (!sender || !ownTransfer(msg.transferId)) return fail('protocol');
        dispatch({ type: 'reject' });
        return;
      case 'ack':
        if (!sender || !ownTransfer(msg.transferId) || gate.state !== 'transferring')
          return fail('protocol');
        if (msg.bytes > (snap.progress?.total ?? 0)) return fail('protocol');
        update({ progress: { confirmed: msg.bytes, total: snap.progress?.total ?? 0 } });
        return;
      case 'complete':
        if (!sender || !ownTransfer(msg.transferId)) return fail('protocol');
        dispatch({ type: 'complete' });
        return;
      case 'file-end': {
        if (sender || !receiver || !ownTransfer(msg.transferId) || !canSendPayload(gate)) {
          return fail('protocol');
        }
        const result = await receiver.fileEnd(msg.fileIdx, msg.root);
        if (!result.ok) return fail(result.reason);
        sendControl({ v: 1, t: 'ack', transferId: msg.transferId, bytes: receiver.confirmed });
        update({ progress: { confirmed: receiver.confirmed, total: snap.progress?.total ?? 0 } });
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
    const downloads = receiver.blobs.map((blob, i) => ({
      name: safeFilename(files[i]!.name),
      size: blob.size,
      blob,
      url: URL.createObjectURL(blob),
    }));
    sendControl({ v: 1, t: 'complete', transferId: manifest.transferId });
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
      update({ progress: { confirmed: receiver.confirmed, total: snap.progress?.total ?? 0 } });
    }
  }

  async function onMessage(data: unknown) {
    if (isTerminal(gate)) return;
    if (data instanceof ArrayBuffer) return onPayload(data);
    const msg = typeof data === 'string' ? parseControl(data) : null;
    if (!msg) return fail('protocol');
    return onControl(msg, data as string);
  }

  function onOpen() {
    if (!dispatch({ type: 'open' }, 'verifying')) return;
    if (o.role === 'offerer' && secrets.nO) {
      sendControl({ v: 1, t: 'sas-reveal', nO: toB64url(secrets.nO) });
      inbox = inbox.then(computeSas);
    }
  }

  channel.binaryType = 'arraybuffer';
  channel.addEventListener('message', (e) => {
    const { data } = e as MessageEvent;
    inbox = inbox.then(() => onMessage(data)).catch(() => void fail('protocol'));
  });
  channel.addEventListener('close', () => {
    if (!isTerminal(gate)) fail('closed');
    closed = true;
    o.onClose();
  });
  if (channel.readyState === 'open') onOpen();
  else channel.addEventListener('open', onOpen);

  function reject() {
    if (o.role !== 'answerer' || !manifest || gate.state !== 'offered') return;
    // Send before the terminal transition, which closes the channel.
    sendControl({ v: 1, t: 'files-reject', transferId: manifest.transferId });
    dispatch({ type: 'reject' });
  }

  return {
    getSnapshot: () => snap,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Local user action only: "The words match". */
    confirm() {
      if (gate.state !== 'verifying' || gate.d === null || gate.localConfirmed) return;
      const d = gate.d;
      const verified = dispatch({ type: 'local-confirm' }, 'verified');
      sendControl({ v: 1, t: 'sas-confirm', d });
      if (o.role === 'offerer' && verified) void sendManifest();
    },
    mismatch: () => void fail('mismatch'),
    /** The peer connection failed or timed out. */
    lost: () => void fail('closed'),
    accept() {
      if (o.role !== 'answerer' || !manifest || gate.state !== 'offered' || snap.tooLarge) return;
      const { transferId } = manifest;
      const manifestDigest = gate.manifestDigest!;
      receiver = createReceiver(manifest);
      if (
        dispatch({ type: 'accept', digest: manifestDigest, fp: fingerprintKey() }, 'transferring')
      ) {
        sendControl({ v: 1, t: 'files-accept', transferId, manifestDigest });
      }
    },
    reject,
    cancel() {
      if (isTerminal(gate)) return;
      sendControl({ v: 1, t: 'cancel' });
      dispatch({ type: 'cancel' });
    },
    /** Releases object URLs and closes the connection. */
    dispose() {
      if (!isTerminal(gate)) this.cancel();
      snap.downloads.forEach((d) => URL.revokeObjectURL(d.url));
    },
  };
}
