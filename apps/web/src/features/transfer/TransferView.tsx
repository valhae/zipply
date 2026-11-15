import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { FailReason } from '../connection/gate';
import { WORD_ATTEMPTS, type Session, type Snapshot } from '../connection/session';
import type { ReceivePlan } from './sinks';

type Direction = 'send' | 'receive';

const FAILURES: Record<FailReason, string> = {
  mismatch:
    'Verification failed: the words did not match. The connection was closed and nothing was shared.',
  commitment:
    'Verification could not be completed safely. The connection was closed and nothing was shared.',
  fingerprint:
    'Verification could not be completed safely. The connection was closed and nothing was shared.',
  protocol: 'The other device sent something unexpected, so the connection was closed.',
  integrity: 'A file failed its integrity check. Nothing was saved; the connection was closed.',
  storage:
    'The received files could not be saved (the browser storage or disk may be full). Partial data was deleted.',
  'too-large': 'The files are larger than this browser can receive.',
  closed: 'The connection was lost before the transfer finished.',
  expired:
    'The paused transfer could not be resumed in time, so it was canceled and partial data was deleted. Send the files again to start over.',
};

const UNITS = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
export function formatBytes(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${n} bytes` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

const formatEta = (s: number) =>
  s < 60
    ? `about ${s} s left`
    : s < 3600
      ? `about ${Math.round(s / 60)} min left`
      : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;

/** Where accepted files will go, shown before Accept (P6-01). */
function placement(plan: ReceivePlan | null): string {
  switch (plan?.kind) {
    case 'folder':
      return 'This is a large transfer: after Accept files, choose a folder to save into.';
    case 'browser':
      return `This is a large transfer: it is kept in this browser's storage first (${
        plan.free === undefined ? 'free space unknown' : `${formatBytes(plan.free)} free`
      }), then saved to your downloads. That needs about twice its size in free disk space for a moment.`;
    default:
      return 'Files are saved to your downloads.';
  }
}

function rejected(plan: ReceivePlan | null, direction: Direction): string {
  if (plan?.kind === null) {
    return plan.reason === 'no-space'
      ? `Rejected automatically: not enough free storage in this browser (${formatBytes(plan.free ?? 0)} available).`
      : 'Rejected automatically: this browser has no way to save files this large (more than 256 MiB). A desktop Chrome or Edge can.';
  }
  return direction === 'send' ? 'The other person rejected the files.' : 'You rejected the files.';
}

function statusText(s: Snapshot, direction: Direction, peer: string): string {
  switch (s.state) {
    case 'connecting':
      return s.resuming
        ? 'Reconnecting to continue the paused transfer…'
        : 'Connecting directly to the other device…';
    case 'verifying':
      if (!s.say) return 'Securing the connection…';
      return s.localConfirmed
        ? 'Waiting for the other person to check your words…'
        : 'Read your words aloud and type the words you hear.';
    case 'verified':
    case 'offered':
      if (s.resuming) return 'Verified. Continuing the paused transfer…';
      return direction === 'send'
        ? 'Verified. Waiting for the other person to accept the files…'
        : 'Verified. Review the incoming files.';
    case 'transferring':
      return direction === 'send' ? 'Sending…' : 'Receiving…';
    case 'paused':
      return direction === 'send'
        ? `Paused: the connection to ${peer} was lost. Reconnect when you can reach each other again; you will check words again.`
        : `Paused: the connection was lost. Waiting for ${peer} to reconnect; you will check words again.`;
    case 'completed':
      if (direction === 'send') return 'Done. The receiver verified every file.';
      return s.downloads.some((d) => d.url === null)
        ? 'Done. Every file passed its integrity check and was saved in the folder you chose.'
        : 'Done. Every file passed its integrity check and is being saved to your downloads. If your browser asks, allow the downloads, or use the Save links.';
    case 'rejected':
      return rejected(s.plan, direction);
    case 'canceled':
      return 'Transfer canceled. Nothing more will be sent.';
    case 'failed':
      return FAILURES[s.reason ?? 'closed'];
  }
}

/** Opt-in, redacted (P6-07): sizes, counters and the route type; no names, SDP, ICE or addresses. */
function DebugPanel({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ReturnType<Session['debug']> | null>(null);
  const [route, setRoute] = useState<{ ice: string; route: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const load = () => {
      const d = session.debug();
      setInfo(d);
      void d.stats?.().then(setRoute);
    };
    load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [open, session]);
  const rows: [string, string][] = info
    ? [
        ['Chunk size', info.chunkSize === null ? '—' : formatBytes(info.chunkSize)],
        ['Max message', info.maxMessageSize === null ? '—' : formatBytes(info.maxMessageSize)],
        ['Watermarks', `${formatBytes(info.high)} / ${formatBytes(info.low)}`],
        ['Checkpoint every', formatBytes(info.ackEvery)],
        ['Buffered', formatBytes(info.bufferedAmount)],
        ...(info.queued === null ? [] : [['Queued', formatBytes(info.queued)] as [string, string]]),
        ['Confirmed', `${formatBytes(info.confirmed)} of ${formatBytes(info.total)}`],
        ['ICE', route?.ice ?? '—'],
        ['Route', route?.route ?? '—'],
      ]
    : [];
  return (
    <details className="mt-6" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="micro cursor-pointer text-[10px] text-gray-500">
        Connection details
      </summary>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-500">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function TransferView({
  session,
  direction,
  peerName = 'the other person',
  onReconnect,
}: {
  session: Session;
  direction: Direction;
  peerName?: string;
  onReconnect?: () => void;
}) {
  const s = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const saved = useRef(new Set<string>());
  const [typed, setTyped] = useState('');

  // Owner decision (2026-10-17): after the user accepted the files and every file passed its
  // integrity check, save them automatically. Still inert: octet-stream, sanitized name, never opened.
  // Files already written into a folder the user picked (url null) are not downloaded again.
  useEffect(() => {
    if (direction !== 'receive' || s.state !== 'completed') return;
    for (const d of s.downloads) {
      if (d.url === null || saved.current.has(d.url)) continue;
      saved.current.add(d.url);
      const a = document.createElement('a');
      a.href = d.url;
      a.download = d.name;
      a.click();
    }
  }, [direction, s.state, s.downloads]);
  const status = statusText(s, direction, peerName);
  const active = !['completed', 'rejected', 'canceled', 'failed'].includes(s.state);
  const verifying = s.state === 'verifying' && s.say !== null;
  const incoming = direction === 'receive' && s.state === 'offered' && s.manifest !== null;
  const moving = s.state === 'transferring' || s.state === 'paused';
  // A dialog also closes when the state moves on; only a close in its own state (Escape) means "no".
  const closeIf = (state: Snapshot['state'], action: () => void) => () => {
    if (session.getSnapshot().state === state) action();
  };
  const p = s.progress;
  const rates =
    p && s.state === 'transferring' && p.speed !== null && p.average !== null
      ? [
          `${formatBytes(p.speed)}/s now`,
          `${formatBytes(p.average)}/s average`,
          ...(p.eta !== null ? [formatEta(p.eta)] : []),
        ].join(' · ')
      : null;

  return (
    <section aria-labelledby="transfer-heading" className="mt-8">
      <h2 id="transfer-heading" className="micro text-[10px] text-gray-600">
        Transfer
      </h2>
      <p role="status" className="mt-3 text-[15px]">
        {status}
      </p>

      {moving && p && (
        <div className="mt-4">
          <progress
            aria-label="Transfer progress"
            className="h-2 w-full accent-ink"
            max={p.total}
            value={p.confirmed}
          />
          <p className="micro mt-2 text-[10px] text-gray-500">
            {formatBytes(p.confirmed)} of {formatBytes(p.total)} confirmed
          </p>
          {rates && <p className="micro mt-1 text-[10px] text-gray-500">{rates}</p>}
          {s.state === 'paused' && s.expiresAt !== null && (
            <p className="mt-2 text-[13px] text-gray-600">
              Kept until{' '}
              {new Date(s.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              ; after that the transfer is canceled and partial data is deleted.
            </p>
          )}
        </div>
      )}

      {s.downloads.length > 0 && (
        <ul className="mt-4 divide-y divide-gray-200 border-y border-gray-200">
          {s.downloads.map((d, i) => (
            <li key={i} className="flex items-center justify-between gap-4 py-3">
              {d.url === null ? (
                <span className="min-w-0 truncate">Saved {d.name}</span>
              ) : (
                // Inert download: octet-stream blob, never opened or rendered here.
                <a href={d.url} download={d.name} className="min-w-0 truncate underline">
                  Save {d.name}
                </a>
              )}
              <span className="micro shrink-0 text-[10px] text-gray-500">
                {formatBytes(d.size)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {active && !verifying && !incoming && (
        <div className="mt-6 flex flex-wrap gap-3">
          {s.state === 'paused' && direction === 'send' && onReconnect && (
            <Button variant="primary" onClick={onReconnect}>
              Reconnect
            </Button>
          )}
          <Button onClick={session.cancel}>{moving ? 'Cancel transfer' : 'Cancel'}</Button>
        </div>
      )}

      {(moving || s.state === 'completed') && <DebugPanel session={session} />}

      <Dialog
        open={verifying}
        onClose={closeIf('verifying', session.cancel)}
        title="Verification required"
      >
        {s.resuming && (
          <p className="mb-3 text-[13px] text-gray-600">
            This is a new connection for the paused transfer, so check the words again.
          </p>
        )}
        <p className="text-[13px] text-gray-600">
          Read these words aloud to the other person, in person or over a call you trust:
        </p>
        <ol className="my-4 flex flex-wrap gap-2">
          {s.say?.map((word, i) => (
            <li
              key={i}
              className="rounded-md border border-gray-200 px-3 py-2 font-mono text-[15px]"
            >
              {word}
            </li>
          ))}
        </ol>
        {s.localConfirmed ? (
          <p className="mb-3 text-[13px] text-gray-600">
            The words you typed are correct. Waiting for the other person to check your words…
          </p>
        ) : (
          <form
            className="mb-3 grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              session.checkWords(typed);
            }}
          >
            <label className="grid gap-2 text-[13px]">
              Words you hear
              <input
                required
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="words-hint"
                className="min-h-11 w-full min-w-0 rounded-md border border-gray-200 bg-bg px-3 font-mono text-[15px]"
              />
            </label>
            <p id="words-hint" className="text-[13px] text-gray-600">
              Type the three words the other person reads from their screen, in order. Your screen
              does not show them; that is how the check works.
            </p>
            {s.attemptsLeft < WORD_ATTEMPTS && (
              <p role="alert" className="text-[13px] text-gray-600">
                Those words do not match. {s.attemptsLeft} {s.attemptsLeft === 1 ? 'try' : 'tries'}{' '}
                left. If the other person reads different words, choose Mismatch.
              </p>
            )}
            <Button type="submit" variant="primary">
              Check words
            </Button>
          </form>
        )}
        <div className="grid gap-3">
          <Button onClick={session.mismatch}>Mismatch — cancel</Button>
        </div>
      </Dialog>

      <Dialog open={incoming} onClose={closeIf('offered', session.reject)} title="Incoming files">
        <p className="text-[13px] text-gray-600">
          {s.manifest?.files.length} file{s.manifest?.files.length === 1 ? '' : 's'},{' '}
          {formatBytes(s.manifest?.total ?? 0)} in total. Files are saved exactly as sent; Zipply
          never opens them.
        </p>
        <p className="mt-2 text-[13px] text-gray-600">{placement(s.plan)}</p>
        <ul className="my-5 max-h-60 divide-y divide-gray-200 overflow-y-auto border-y border-gray-200">
          {s.manifest?.files.map((f, i) => (
            <li key={i} className="flex justify-between gap-4 py-2 text-[13px]">
              <span className="min-w-0 break-all">{f.name}</span>
              <span className="micro shrink-0 text-[10px] text-gray-500">
                {formatBytes(f.size)}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid gap-3">
          <Button variant="primary" onClick={() => void session.accept()}>
            Accept files
          </Button>
          <Button onClick={session.reject}>Reject files</Button>
        </div>
      </Dialog>
    </section>
  );
}
