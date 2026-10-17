import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { FailReason } from '../connection/gate';
import type { Session, Snapshot } from '../connection/session';

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
  'too-large': 'The files are larger than this browser can receive.',
  closed: 'The connection was lost before the transfer finished.',
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

function statusText(s: Snapshot, direction: Direction): string {
  switch (s.state) {
    case 'connecting':
      return 'Connecting directly to the other device…';
    case 'verifying':
      if (!s.phrase) return 'Securing the connection…';
      return s.localConfirmed
        ? 'Waiting for the other person to confirm the words…'
        : 'Compare the verification words.';
    case 'verified':
    case 'offered':
      return direction === 'send'
        ? 'Verified. Waiting for the other person to accept the files…'
        : 'Verified. Review the incoming files.';
    case 'transferring':
      return direction === 'send' ? 'Sending…' : 'Receiving…';
    case 'completed':
      return direction === 'send'
        ? 'Done. The receiver verified every file.'
        : 'Done. Every file passed its integrity check and is being saved to your downloads. If your browser asks, allow the downloads, or use the Save links.';
    case 'rejected':
      if (s.tooLarge) {
        return 'Rejected automatically: the files are larger than this browser can receive (256 MiB limit for now).';
      }
      return direction === 'send'
        ? 'The other person rejected the files.'
        : 'You rejected the files.';
    case 'canceled':
      return 'Transfer canceled. Nothing more will be sent.';
    case 'failed':
      return FAILURES[s.reason ?? 'closed'];
  }
}

export function TransferView({ session, direction }: { session: Session; direction: Direction }) {
  const s = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const saved = useRef(new Set<string>());

  // Owner decision (2026-10-17): after the user accepted the files and every file passed its
  // integrity check, save them automatically. Still inert: octet-stream, sanitized name, never opened.
  useEffect(() => {
    if (direction !== 'receive' || s.state !== 'completed') return;
    for (const d of s.downloads) {
      if (saved.current.has(d.url)) continue;
      saved.current.add(d.url);
      const a = document.createElement('a');
      a.href = d.url;
      a.download = d.name;
      a.click();
    }
  }, [direction, s.state, s.downloads]);
  const status = statusText(s, direction);
  const active = !['completed', 'rejected', 'canceled', 'failed'].includes(s.state);
  const verifying = s.state === 'verifying' && s.phrase !== null;
  const incoming = direction === 'receive' && s.state === 'offered' && s.manifest !== null;
  // A dialog also closes when the state moves on; only a close in its own state (Escape) means "no".
  const closeIf = (state: Snapshot['state'], action: () => void) => () => {
    if (session.getSnapshot().state === state) action();
  };

  return (
    <section aria-labelledby="transfer-heading" className="mt-8">
      <h2 id="transfer-heading" className="micro text-[10px] text-gray-600">
        Transfer
      </h2>
      <p role="status" className="mt-3 text-[15px]">
        {status}
      </p>

      {s.state === 'transferring' && s.progress && (
        <div className="mt-4">
          <progress
            aria-label="Transfer progress"
            className="h-2 w-full accent-ink"
            max={s.progress.total}
            value={s.progress.confirmed}
          />
          <p className="micro mt-2 text-[10px] text-gray-500">
            {formatBytes(s.progress.confirmed)} of {formatBytes(s.progress.total)} confirmed
          </p>
        </div>
      )}

      {s.downloads.length > 0 && (
        <ul className="mt-4 divide-y divide-gray-200 border-y border-gray-200">
          {s.downloads.map((d) => (
            <li key={d.url} className="flex items-center justify-between gap-4 py-3">
              {/* Inert download: octet-stream blob, never opened or rendered here. */}
              <a href={d.url} download={d.name} className="min-w-0 truncate underline">
                Save {d.name}
              </a>
              <span className="micro shrink-0 text-[10px] text-gray-500">
                {formatBytes(d.size)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {active && !verifying && !incoming && (
        <Button className="mt-6" onClick={session.cancel}>
          {s.state === 'transferring' ? 'Cancel transfer' : 'Cancel'}
        </Button>
      )}

      <Dialog
        open={verifying}
        onClose={closeIf('verifying', session.cancel)}
        title="Verification required"
      >
        <p className="text-[13px] text-gray-600">
          Compare these words with the other person, in person or over a call you trust. Do not
          continue if any word differs.
        </p>
        <ol className="my-5 grid grid-cols-2 gap-2">
          {s.phrase?.map((word, i) => (
            <li
              key={i}
              className="flex items-baseline gap-2 rounded-md border border-gray-200 px-3 py-2"
            >
              <span className="micro text-[10px] text-gray-500">{i + 1}</span>
              <span className="font-mono text-[15px]">{word}</span>
            </li>
          ))}
        </ol>
        {s.localConfirmed ? (
          <p className="mb-3 text-[13px] text-gray-600">Waiting for the other person to confirm…</p>
        ) : null}
        <div className="grid gap-3">
          {!s.localConfirmed && (
            <Button variant="primary" onClick={session.confirm}>
              The words match
            </Button>
          )}
          <Button onClick={session.mismatch}>Mismatch — cancel</Button>
        </div>
      </Dialog>

      <Dialog open={incoming} onClose={closeIf('offered', session.reject)} title="Incoming files">
        <p className="text-[13px] text-gray-600">
          {s.manifest?.files.length} file{s.manifest?.files.length === 1 ? '' : 's'},{' '}
          {formatBytes(s.manifest?.total ?? 0)} in total. Files are saved exactly as sent; Zipply
          never opens them.
        </p>
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
          <Button variant="primary" onClick={session.accept}>
            Accept files
          </Button>
          <Button onClick={session.reject}>Reject files</Button>
        </div>
      </Dialog>
    </section>
  );
}
