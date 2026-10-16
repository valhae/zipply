import { describe, expect, it } from 'vitest';
import {
  INITIAL_GATE,
  canSendPayload,
  isTerminal,
  transition,
  type Gate,
  type GateEvent,
  type GateState,
} from './gate';

const D = 'digest-1';
const FP = 'fp-1';
const M = 'manifest-1';

// Every event kind with a well-formed payload.
const EVENTS: Record<string, GateEvent> = {
  open: { type: 'open' },
  'sas-ready': { type: 'sas-ready', d: D, fp: FP },
  'local-confirm': { type: 'local-confirm' },
  'remote-confirm': { type: 'remote-confirm', d: D },
  manifest: { type: 'manifest', digest: M, fp: FP },
  accept: { type: 'accept', digest: M, fp: FP },
  reject: { type: 'reject' },
  complete: { type: 'complete' },
  cancel: { type: 'cancel' },
  fail: { type: 'fail', reason: 'closed' },
};

const run = (...names: string[]): Gate =>
  names.reduce((g, n) => transition(g, EVENTS[n]!), INITIAL_GATE);

const FIXTURES: Record<string, Gate> = {
  connecting: run(),
  verifying: run('open'),
  'verifying+sas': run('open', 'sas-ready'),
  'verifying+local': run('open', 'sas-ready', 'local-confirm'),
  'verifying+remote': run('open', 'sas-ready', 'remote-confirm'),
  verified: run('open', 'sas-ready', 'local-confirm', 'remote-confirm'),
  offered: run('open', 'sas-ready', 'local-confirm', 'remote-confirm', 'manifest'),
  transferring: run('open', 'sas-ready', 'local-confirm', 'remote-confirm', 'manifest', 'accept'),
  completed: run(
    'open',
    'sas-ready',
    'local-confirm',
    'remote-confirm',
    'manifest',
    'accept',
    'complete',
  ),
  rejected: run('open', 'sas-ready', 'local-confirm', 'remote-confirm', 'manifest', 'reject'),
  canceled: run('cancel'),
  failed: run('fail'),
};

// Expected state after each event; anything not listed is illegal and must fail closed.
const LEGAL: Record<string, Partial<Record<string, GateState>>> = {
  connecting: { open: 'verifying' },
  verifying: { 'sas-ready': 'verifying' },
  'verifying+sas': { 'local-confirm': 'verifying', 'remote-confirm': 'verifying' },
  'verifying+local': { 'remote-confirm': 'verified' },
  'verifying+remote': { 'local-confirm': 'verified' },
  verified: { manifest: 'offered' },
  offered: { accept: 'transferring', reject: 'rejected' },
  transferring: { complete: 'completed' },
};
const TERMINAL = ['completed', 'rejected', 'canceled', 'failed'];

describe('gate fixtures', () => {
  it.each(Object.entries(FIXTURES))('%s is in the expected state', (name, gate) => {
    expect(gate.state).toBe(name.split('+')[0]);
  });
});

describe('gate transitions (exhaustive)', () => {
  for (const [name, gate] of Object.entries(FIXTURES)) {
    for (const [eventName, event] of Object.entries(EVENTS)) {
      const terminal = TERMINAL.includes(name);
      const expected = terminal
        ? gate.state // absorbing
        : (LEGAL[name]?.[eventName] ?? (eventName === 'cancel' ? 'canceled' : 'failed'));
      it(`${name} + ${eventName} → ${expected}`, () => {
        const next = transition(gate, event);
        expect(next.state).toBe(expected);
        if (terminal) expect(next).toBe(gate);
        if (!terminal && expected === 'failed' && eventName !== 'fail') {
          expect(next.reason).toBe('protocol');
        }
      });
    }
  }
});

describe('gate payload checks fail closed', () => {
  it('remote confirmation with a different digest is a mismatch', () => {
    const g = transition(FIXTURES['verifying+local']!, { type: 'remote-confirm', d: 'other' });
    expect(g).toMatchObject({ state: 'failed', reason: 'mismatch' });
  });

  it('a changed fingerprint blocks the manifest', () => {
    const g = transition(FIXTURES.verified!, { type: 'manifest', digest: M, fp: 'fp-2' });
    expect(g).toMatchObject({ state: 'failed', reason: 'fingerprint' });
  });

  it('a changed fingerprint blocks acceptance', () => {
    const g = transition(FIXTURES.offered!, { type: 'accept', digest: M, fp: 'fp-2' });
    expect(g).toMatchObject({ state: 'failed', reason: 'fingerprint' });
  });

  it('acceptance of a different manifest fails', () => {
    const g = transition(FIXTURES.offered!, { type: 'accept', digest: 'other', fp: FP });
    expect(g).toMatchObject({ state: 'failed', reason: 'protocol' });
  });

  it('a remote message can never set the local confirmation', () => {
    const g = transition(FIXTURES['verifying+sas']!, { type: 'remote-confirm', d: D });
    expect(g.localConfirmed).toBe(false);
    expect(g.state).toBe('verifying');
  });

  it('keeps the failure reason given', () => {
    expect(transition(FIXTURES.transferring!, { type: 'fail', reason: 'integrity' })).toMatchObject(
      {
        state: 'failed',
        reason: 'integrity',
      },
    );
  });
});

describe('gate queries', () => {
  it('only allows payload while transferring', () => {
    for (const [name, gate] of Object.entries(FIXTURES)) {
      expect(canSendPayload(gate), name).toBe(name === 'transferring');
    }
  });

  it('marks exactly the four terminal states', () => {
    for (const [name, gate] of Object.entries(FIXTURES)) {
      expect(isTerminal(gate), name).toBe(TERMINAL.includes(name));
    }
  });
});
