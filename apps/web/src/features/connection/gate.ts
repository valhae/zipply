export type GateState =
  | 'connecting'
  | 'verifying'
  | 'verified'
  | 'offered'
  | 'transferring'
  | 'completed'
  | 'rejected'
  | 'canceled'
  | 'failed';

export type FailReason =
  'mismatch' | 'commitment' | 'fingerprint' | 'protocol' | 'integrity' | 'too-large' | 'closed';

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
  | { type: 'fail'; reason: FailReason };

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

/**
 * Pure gate (SECURITY_DECISIONS SD-03). Terminal states absorb every event; any event not legal
 * in the current state fails closed. Only `local-confirm` (a local user action) sets local confirmation.
 */
export function transition(g: Gate, e: GateEvent): Gate {
  if (isTerminal(g)) return g;
  if (e.type === 'cancel') return { ...g, state: 'canceled' };
  if (e.type === 'fail') return fail(g, e.reason);

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
      if (e.type === 'manifest') {
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
      break;
  }
  return fail(g, 'protocol');
}
