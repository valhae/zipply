// DEV ONLY (?harness). Loaded through `import.meta.env.DEV` in main.tsx, so it is absent from
// production builds (asserted by e2e/production.spec.ts). Same-browser signaling over
// BroadcastChannel stands in for the Phase 4 signaling service. Never log the signals.
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { TransferView } from '../transfer/TransferView';
import { createPeer, iceServers, parseSignal, type Signal } from './peer';
import { randomBytes, toB64url } from './sas';
import type { Session } from './session';

const CHANNEL = 'zipply-dev-harness';
const ICE = iceServers(import.meta.env.VITE_STUN_URLS as string | undefined);
const KINDS = ['request', 'request-accept', 'request-reject', 'signal'] as const;

type Message = { from: string; to?: string; kind: (typeof KINDS)[number]; signal?: unknown };
type Phase = 'idle' | 'requesting' | 'incoming' | 'rejected' | 'connecting';

function parseMessage(data: unknown): Message | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  const kind = KINDS.find((k) => k === m.kind);
  if (!kind || typeof m.from !== 'string' || (m.to !== undefined && typeof m.to !== 'string'))
    return null;
  return { from: m.from, to: m.to as string | undefined, kind, signal: m.signal };
}

export default function DevHarness() {
  const [me] = useState(() => toB64url(randomBytes(8)));
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<'offerer' | 'answerer'>('offerer');
  // Mirror for the BroadcastChannel handler; written only in handlers, never during render.
  const state = useRef({
    phase: 'idle' as Phase,
    other: null as string | null,
    files: [] as File[],
  });
  const setPhase = (next: Phase) => {
    state.current.phase = next;
    setPhaseState(next);
  };
  const channel = useRef<BroadcastChannel | null>(null);
  const peer = useRef<ReturnType<typeof createPeer> | null>(null);

  const post = (msg: Omit<Message, 'from'> & { signal?: Signal }) =>
    channel.current?.postMessage({ ...msg, from: me });

  const startPeer = (asRole: 'offerer' | 'answerer', other: string) => {
    state.current.other = other;
    setRole(asRole);
    setPhase('connecting');
    peer.current = createPeer({
      role: asRole,
      iceServers: ICE,
      files: asRole === 'offerer' ? state.current.files : undefined,
      send: (signal) => post({ kind: 'signal', to: other, signal }),
      onSession: setSession,
    });
    return peer.current;
  };

  useEffect(() => {
    const bc = new BroadcastChannel(CHANNEL);
    channel.current = bc;
    bc.onmessage = (e: MessageEvent) => {
      const msg = parseMessage(e.data);
      if (!msg || (msg.to !== undefined && msg.to !== me)) return;
      const s = state.current;
      if (msg.kind === 'request' && s.phase === 'idle') {
        s.other = msg.from;
        setPhase('incoming');
      } else if (msg.kind === 'request-accept' && s.phase === 'requesting') {
        void startPeer('offerer', msg.from).start();
      } else if (msg.kind === 'request-reject' && s.phase === 'requesting') {
        setPhase('rejected');
      } else if (msg.kind === 'signal' && msg.from === s.other) {
        const signal = parseSignal(msg.signal);
        if (signal) peer.current?.handle(signal);
      }
    };
    return () => {
      bc.close();
      peer.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one channel per mounted tab
  }, [me]);

  useEffect(() => () => session?.dispose(), [session]);

  const reset = () => {
    session?.cancel();
    peer.current?.close();
    peer.current = null;
    state.current.other = null;
    setSession(null);
    setPhase('idle');
  };

  const statusText: Record<Phase, string> = {
    idle: 'Open this page in a second tab, pick files here and request a connection.',
    requesting: 'Waiting for the other tab to accept the connection…',
    incoming: 'Another tab wants to connect.',
    rejected: 'The other tab rejected the connection.',
    connecting: 'Connecting…',
  };

  return (
    <main className="mx-auto w-full max-w-[40rem] px-4 py-14 sm:px-6">
      <h1 className="font-pixel text-3xl lowercase">Dev harness</h1>
      <p className="micro mt-3 text-[10px] text-gray-500">
        Development only · same-browser transfer · not part of production
      </p>

      {!session && (
        <>
          <p role="status" className="mt-8 text-[15px]">
            {statusText[phase]}
          </p>
          {phase === 'idle' && (
            <div className="mt-6 grid gap-4">
              <label className="grid gap-2 text-[13px]">
                Files to send
                <input
                  type="file"
                  multiple
                  onChange={(e) => {
                    const picked = [...(e.target.files ?? [])];
                    state.current.files = picked;
                    setFiles(picked);
                  }}
                  className="text-[13px]"
                />
              </label>
              <Button
                variant="primary"
                disabled={files.length === 0}
                onClick={() => {
                  setPhase('requesting');
                  post({ kind: 'request' });
                }}
              >
                Request connection
              </Button>
            </div>
          )}
          {phase !== 'idle' && phase !== 'incoming' && (
            <Button className="mt-6" onClick={reset}>
              {phase === 'rejected' ? 'Start over' : 'Cancel'}
            </Button>
          )}
        </>
      )}

      {session && (
        <>
          <TransferView session={session} direction={role === 'offerer' ? 'send' : 'receive'} />
          <Button className="mt-6" onClick={reset}>
            Start over
          </Button>
        </>
      )}

      <Dialog
        open={phase === 'incoming'}
        onClose={() => state.current.phase === 'incoming' && setPhase('idle')}
        title="Connection request"
      >
        <p className="text-[13px] text-gray-600">
          Accepting only connects the two tabs. You will compare verification words before any file
          details are shared, and you decide on the files after that.
        </p>
        <div className="mt-6 grid gap-3">
          <Button
            variant="primary"
            onClick={() => {
              const other = state.current.other!;
              post({ kind: 'request-accept', to: other });
              startPeer('answerer', other);
            }}
          >
            Accept connection
          </Button>
          <Button
            onClick={() => {
              post({ kind: 'request-reject', to: state.current.other! });
              reset();
            }}
          >
            Reject connection
          </Button>
        </div>
      </Dialog>
    </main>
  );
}
