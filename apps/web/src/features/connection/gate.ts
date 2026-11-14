export type GateState =
  | 'connecting'
  | 'verifying'
  | 'verified'
  | 'offered'
  | 'transferring'
  | 'paused'
  | 'completed'
  | 'rejected'
  | 'canceled'
  | 'failed';

export type FailReason =
  | 'mismatch'
  | 'commitment'
  | 'fingerprint'
  | 'protocol'
  | 'integrity'
  | 'storage'
  | 'too-large'
  | 'closed'
  | 'expired';

export interface Gate {
  state: GateState;
  d: string | null;
  fp: string | null;
  localConfirmed: boolean;
  remoteConfirmed: boolean;
  manifestDigest: string | null;
  reason?: FailReason;
}

export type GateEvent =
  | { type: 'open' }
  | { type: 'sas-ready'; d: string; fp: string }
  | { type: 'local-confirm' }
  | { type: 'remote-confirm'; d: string }
  | { type: 'manifest'; digest: string; fp: string }
  | { type: 'accept'; digest: string; fp: string }
  | { type: 'reject' }
  | { type: 'complete' }
  | { type: 'cancel' }
  | { type: 'fail'; reason: FailReason }
  /** The connection was lost; a transfer in progress pauses (P6-05). */
  | { type: 'lost' }
  /** A new connection for a paused transfer: the word check starts again (D4). */
  | { type: 'reattach' }
  /** The resume proof matched on the new, verified connection. */
  | { type: 'resume'; fp: string };

export const INITIAL_GATE: Gate = {
  state: 'connecting',
  d: null,
  fp: null,
  localConfirmed: false,
  remoteConfirmed: false,
  manifestDigest: null,
};

const TERMINAL: GateState[] = ['completed', 'rejected', 'canceled', 'failed'];

export const isTerminal = (g: Gate) => TERMINAL.includes(g.state);
export const canSendPayload = (g: Gate) => g.state === 'transferring';

const fail = (g: Gate, reason: FailReason): Gate => ({ ...g, state: 'failed', reason });

// A new connection for a paused transfer, before the transfer resumed on it.
const resuming = (g: Gate) =>
  g.manifestDigest !== null && ['connecting', 'verifying', 'verified'].includes(g.state);

/**
 * Pure gate (SECURITY_DECISIONS SD-03, SD-07). Terminal states absorb every event; any event not
 * legal in the current state fails closed. Only `local-confirm` (a local user action) sets local
 * confirmation. A failure on a new connection for a paused transfer, before it resumed, closes that
 * connection but leaves the transfer paused, so no bytes flow and the user can try again.
 */
export function transition(g: Gate, e: GateEvent): Gate {
  if (isTerminal(g)) return g;
  if (e.type === 'cancel') return { ...g, state: 'canceled' };
  const next = step(g, e);
  return next.state === 'failed' && resuming(g) ? { ...next, state: 'paused' } : next;
}

function step(g: Gate, e: GateEvent): Gate {
  if (e.type === 'fail') return fail(g, e.reason);
  if (e.type === 'lost' && g.state !== 'transferring') return fail(g, 'closed');

  const both = (next: Gate): Gate =>
    next.localConfirmed && next.remoteConfirmed ? { ...next, state: 'verified' } : next;

  switch (g.state) {
    case 'connecting':
      if (e.type === 'open') return { ...g, state: 'verifying' };
      break;
    case 'verifying':
      if (e.type === 'sas-ready' && g.d === null) return { ...g, d: e.d, fp: e.fp };
      if (e.type === 'local-confirm' && g.d !== null && !g.localConfirmed) {
        return both({ ...g, localConfirmed: true });
      }
      if (e.type === 'remote-confirm' && g.d !== null && !g.remoteConfirmed) {
        return e.d === g.d ? both({ ...g, remoteConfirmed: true }) : fail(g, 'mismatch');
      }
      break;
    case 'verified':
      if (e.type === 'resume' && g.manifestDigest !== null) {
        return e.fp === g.fp ? { ...g, state: 'transferring' } : fail(g, 'fingerprint');
      }
      if (e.type === 'manifest' && g.manifestDigest === null) {
        return e.fp === g.fp
          ? { ...g, state: 'offered', manifestDigest: e.digest }
          : fail(g, 'fingerprint');
      }
      break;
    case 'offered':
      if (e.type === 'reject') return { ...g, state: 'rejected' };
      if (e.type === 'accept') {
        if (e.fp !== g.fp) return fail(g, 'fingerprint');
        if (e.digest === g.manifestDigest) return { ...g, state: 'transferring' };
      }
      break;
    case 'transferring':
      if (e.type === 'complete') return { ...g, state: 'completed' };
      if (e.type === 'lost') return { ...g, state: 'paused' };
      break;
    case 'paused':
      if (e.type === 'reattach') {
        return {
          ...g,
          state: 'connecting',
          d: null,
          fp: null,
          localConfirmed: false,
          remoteConfirmed: false,
          reason: undefined,
        };
      }
      break;
  }
  return fail(g, 'protocol');
}
