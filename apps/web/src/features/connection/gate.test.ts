import fc from 'fast-check';
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
  lost: { type: 'lost' },
  reattach: { type: 'reattach' },
  resume: { type: 'resume', fp: FP },
};

const run = (...names: string[]): Gate =>
  names.reduce((g, n) => transition(g, EVENTS[n]!), INITIAL_GATE);

const TRANSFER = ['open', 'sas-ready', 'local-confirm', 'remote-confirm', 'manifest', 'accept'];

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
  // P6-05: a transfer paused by a lost connection, then a new connection for it (D4).
  paused: run('open', 'sas-ready', 'local-confirm', 'remote-confirm', 'manifest', 'accept', 'lost'),
  'connecting+resume': run(...TRANSFER, 'lost', 'reattach'),
  'verifying+resume': run(...TRANSFER, 'lost', 'reattach', 'open'),
  'verified+resume': run(
    ...TRANSFER,
    'lost',
    'reattach',
    'open',
    'sas-ready',
    'local-confirm',
    'remote-confirm',
  ),
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
  transferring: { complete: 'completed', lost: 'paused' },
  paused: { reattach: 'connecting' },
  'connecting+resume': { open: 'verifying' },
  'verifying+resume': { 'sas-ready': 'verifying' },
  'verified+resume': { resume: 'transferring' },
};
// Before the transfer resumes, a failure on the new connection leaves the transfer paused.
const RESUMING = ['connecting+resume', 'verifying+resume', 'verified+resume'];
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
        : (LEGAL[name]?.[eventName] ??
          (eventName === 'cancel' ? 'canceled' : RESUMING.includes(name) ? 'paused' : 'failed'));
      it(`${name} + ${eventName} → ${expected}`, () => {
        const next = transition(gate, event);
        expect(next.state).toBe(expected);
        if (terminal) expect(next).toBe(gate);
        if (!terminal && expected === 'failed' && !['fail', 'lost'].includes(eventName)) {
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

describe('gate resume (P6-05, D4)', () => {
  it('a new connection starts the word check from scratch but keeps the accepted manifest', () => {
    const g = FIXTURES['connecting+resume']!;
    expect(g).toMatchObject({
      d: null,
      fp: null,
      localConfirmed: false,
      remoteConfirmed: false,
      manifestDigest: M,
    });
    expect(g.reason).toBeUndefined();
  });

  it('resume needs the fingerprints the words were computed from', () => {
    const g = transition(FIXTURES['verified+resume']!, { type: 'resume', fp: 'fp-2' });
    expect(g).toMatchObject({ state: 'paused', reason: 'fingerprint' });
  });

  it('a resumed connection cannot offer a new manifest', () => {
    const g = transition(FIXTURES['verified+resume']!, EVENTS.manifest!);
    expect(g.state).toBe('paused');
  });

  it('a fresh connection cannot resume', () => {
    expect(transition(FIXTURES.verified!, EVENTS.resume!)).toMatchObject({
      state: 'failed',
      reason: 'protocol',
    });
  });

  it('a lost connection before the transfer started fails it', () => {
    expect(transition(FIXTURES.offered!, EVENTS.lost!)).toMatchObject({
      state: 'failed',
      reason: 'closed',
    });
  });

  it('a failure while transferring after a resume is final', () => {
    const g = transition(FIXTURES['verified+resume']!, EVENTS.resume!);
    expect(transition(g, { type: 'fail', reason: 'integrity' }).state).toBe('failed');
  });

  it('a paused transfer that fails (for example, it expired) is final', () => {
    expect(transition(FIXTURES.paused!, { type: 'fail', reason: 'expired' }).state).toBe('failed');
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

// P5-03: no event sequence, in any order and with any values, reaches the manifest or payload
// without a local confirmation and a remote confirmation of the same digest.
describe('no skip path (property, P5-03)', () => {
  const value = fc.constantFrom('a', 'b');
  const event: fc.Arbitrary<GateEvent> = fc.oneof(
    fc.constant({ type: 'open' } as const),
    fc.record({ type: fc.constant('sas-ready' as const), d: value, fp: value }),
    fc.constant({ type: 'local-confirm' } as const),
    fc.record({ type: fc.constant('remote-confirm' as const), d: value }),
    fc.record({ type: fc.constant('manifest' as const), digest: value, fp: value }),
    fc.record({ type: fc.constant('accept' as const), digest: value, fp: value }),
    fc.constant({ type: 'reject' } as const),
    fc.constant({ type: 'complete' } as const),
    fc.constant({ type: 'cancel' } as const),
    fc.constant({ type: 'lost' } as const),
    fc.constant({ type: 'reattach' } as const),
    fc.record({ type: fc.constant('resume' as const), fp: value }),
  );

  // A random-length prefix of the honest path, then random events, so deep states (transferring,
  // paused, a new connection) are reached often; a prefix of 0 is a fully random sequence.
  const sequence = fc
    .tuple(fc.integer({ min: 0, max: TRANSFER.length + 1 }), fc.array(event, { maxLength: 12 }))
    .map(([k, tail]) => [...[...TRANSFER, 'lost'].slice(0, k).map((n) => EVENTS[n]!), ...tail]);

  it('manifest and payload states need both confirmations of the same digest on this connection', () => {
    fc.assert(
      fc.property(sequence, (events) => {
        let g = INITIAL_GATE;
        const all: GateEvent[] = [];
        let seen: GateEvent[] = []; // events on the current connection
        for (const e of events) {
          const before = g.state;
          g = transition(g, e);
          all.push(e);
          // A lost connection ends it: what was confirmed there no longer counts.
          seen = g.state === 'paused' && before !== 'paused' ? [] : [...seen, e];
          if (['verified', 'offered', 'transferring', 'completed', 'rejected'].includes(g.state)) {
            const ready = seen.find((x) => x.type === 'sas-ready');
            expect(ready).toBeDefined();
            expect(seen.some((x) => x.type === 'local-confirm')).toBe(true);
            expect(
              seen.some((x) => x.type === 'remote-confirm' && x.d === (ready as { d: string }).d),
            ).toBe(true);
          }
          if (canSendPayload(g)) {
            const m = all.find((x) => x.type === 'manifest') as { digest: string };
            expect(all.some((x) => x.type === 'accept' && x.digest === m.digest)).toBe(true);
            if (all.length !== seen.length)
              expect(seen.some((x) => x.type === 'resume')).toBe(true);
          }
        }
      }),
      { numRuns: 5000 },
    );
  });

  it('only a local-confirm event ever sets the local confirmation', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 12 }), (events) => {
        const remoteOnly = events.filter((e) => e.type !== 'local-confirm');
        expect(remoteOnly.reduce(transition, INITIAL_GATE).localConfirmed).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });
});
