import { useCallback, useId, useState, useSyncExternalStore } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { ConnectionPanel } from '../connection/ConnectionPanel';
import { IDLE_LINK } from '../connection/link';
import type { Pairing, PairingSnapshot } from './pairing';
import { Qr } from './Qr';
import { Scanner } from './Scanner';

const ERRORS: Record<NonNullable<PairingSnapshot['error']>, string> = {
  'not-zipply': 'That is not a Zipply pairing code.',
  invalid: 'That code is damaged or incomplete. Copy it again.',
  'wrong-kind': 'That code belongs on the other device.',
};

const none = () => () => {};

/** Why a direct local connection can fail (spec §24 step 6); shown before and after an attempt. */
function Limits() {
  return (
    <div className="text-[13px] text-gray-600">
      <p>
        Works only when the two devices can reach each other directly, usually on the same Wi-Fi.
        Zipply does not search the network: you carry a code from one device to the other.
      </p>
      <p className="mt-2">It can fail when:</p>
      <ul className="mt-1 list-disc pl-5">
        <li>the router keeps devices apart (guest or isolated Wi-Fi);</li>
        <li>a VPN is on, on either device;</li>
        <li>
          the browser hides local addresses behind local network names (mDNS) that the other device
          cannot resolve.
        </li>
      </ul>
    </div>
  );
}

/** A code to carry to the other device: text to copy, and a QR to scan. Network metadata. */
function CodeOut({ label, code }: { label: string; code: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <label htmlFor={id} className="text-[13px]">
        {label}
      </label>
      <textarea
        id={id}
        readOnly
        value={code}
        rows={3}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] break-all"
      />
      <Button
        onClick={() =>
          void navigator.clipboard?.writeText(code).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? 'Copied' : 'Copy code'}
      </Button>
      <Qr text={code} label={`QR code of ${label.toLowerCase()}`} />
      <p className="text-[13px] text-gray-600">
        The code contains your device&apos;s network addresses. Share it only with the other device;
        some systems keep copied text in a clipboard history.
      </p>
    </div>
  );
}

/** A code typed, pasted or scanned from the other device. Scanning only fills the field. */
function CodeIn({
  label,
  action,
  disabled,
  onUse,
}: {
  label: string;
  action: string;
  disabled: boolean;
  onUse: (code: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [scanning, setScanning] = useState(false);
  const scanned = useCallback((code: string) => {
    setText(code);
    setScanning(false);
  }, []);
  return (
    <div className="grid gap-3">
      <label htmlFor={id} className="text-[13px]">
        {label}
      </label>
      <textarea
        id={id}
        value={text}
        rows={3}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded-md border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] break-all"
      />
      <div className="flex flex-wrap gap-3">
        <Button disabled={disabled} onClick={() => setScanning(true)}>
          Scan QR code
        </Button>
        <Button
          variant="primary"
          disabled={disabled || text.trim() === ''}
          onClick={() => onUse(text)}
        >
          {action}
        </Button>
      </div>
      {scanning && (
        <Dialog open onClose={() => setScanning(false)} title="Scan QR code">
          <Scanner onCode={scanned} />
          <Button className="mt-4 w-full" onClick={() => setScanning(false)}>
            Close
          </Button>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Manual pairing without the online service (P7-03/P7-04/P7-05). The sender makes a code, the
 * receiver answers with one, and then the usual word check and Accept files follow.
 */
export function PairingPanel({ pairing, busy }: { pairing: Pairing; busy: boolean }) {
  const s = useSyncExternalStore(pairing.subscribe, pairing.getSnapshot);
  const state = useSyncExternalStore(
    s.session?.subscribe ?? none,
    () => s.session?.getSnapshot().state ?? null,
  );
  const [files, setFiles] = useState<File[]>([]);
  const filesId = useId();
  const error = s.error && (
    <p role="alert" className="text-[13px] font-medium">
      {ERRORS[s.error]}
    </p>
  );
  const cancel = (
    <Button className="justify-self-start" onClick={pairing.cancel}>
      Cancel
    </Button>
  );

  if (s.phase === 'creating') {
    return (
      <div className="grid gap-4">
        <p role="status">Preparing the code. This can take up to 10 seconds…</p>
        {cancel}
      </div>
    );
  }

  if (s.phase === 'offer' && s.code) {
    return (
      <div className="grid gap-8">
        <section className="grid gap-3">
          <h3 className="micro text-[10px] text-gray-600">1 — on this device</h3>
          <CodeOut label="Your pairing code" code={s.code} />
        </section>
        <section className="grid gap-3">
          <h3 className="micro text-[10px] text-gray-600">2 — from the receiving device</h3>
          <CodeIn
            label="Answer code from the receiving device"
            action="Connect"
            disabled={false}
            onUse={(code) => void pairing.connect(code)}
          />
          {error}
        </section>
        {cancel}
      </div>
    );
  }

  if (s.phase === 'session' && s.session) {
    if (s.role === 'answerer' && s.code && state === 'connecting') {
      return (
        <div className="grid gap-4">
          <CodeOut label="Your answer code" code={s.code} />
          <p role="status">Waiting for the sending device to use this answer…</p>
          {cancel}
        </div>
      );
    }
    const link = { ...IDLE_LINK, phase: 'session' as const, session: s.session, role: s.role };
    return (
      <div className="grid gap-6">
        <ConnectionPanel
          link={link}
          onCancel={pairing.cancel}
          onDismiss={pairing.dismiss}
          onReconnect={() => pairing.send([])}
        />
        {state === 'paused' && s.role === 'offerer' && (
          <p className="text-[13px] text-gray-600">
            Reconnect makes a new pairing code for the receiving device.
          </p>
        )}
        {state === 'paused' && s.role === 'answerer' && (
          <>
            <CodeIn
              label="New code from the sending device"
              action="Create answer"
              disabled={false}
              onUse={(code) => void pairing.receive(code)}
            />
            {error}
          </>
        )}
      </div>
    );
  }

  if (s.phase === 'ended') {
    return (
      <div className="grid gap-4">
        <p role="status">
          The connection could not be set up. The devices may not be able to reach each other
          directly, or a code was not used within 5 minutes.
        </p>
        <Limits />
        <Button className="justify-self-start" onClick={pairing.dismiss}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <Limits />
      {error}
      <div className="grid gap-6 sm:grid-cols-2">
        <section className="grid content-start gap-3 rounded-2xl border border-gray-200 p-5">
          <h3 className="font-medium">Send files</h3>
          <label htmlFor={filesId} className="text-[13px]">
            Files to send
          </label>
          <input
            id={filesId}
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
            className="text-[13px]"
          />
          <Button
            variant="primary"
            disabled={busy || files.length === 0}
            onClick={() => pairing.send(files)}
          >
            Create pairing code
          </Button>
        </section>
        <section className="grid content-start gap-3 rounded-2xl border border-gray-200 p-5">
          <h3 className="font-medium">Receive files</h3>
          <CodeIn
            label="Code from the sending device"
            action="Create answer"
            disabled={busy}
            onUse={(code) => void pairing.receive(code)}
          />
        </section>
      </div>
      {busy && (
        <p className="text-[13px] text-gray-600">
          Finish or close the online connection first; one connection at a time.
        </p>
      )}
    </div>
  );
}

export default PairingPanel;
