import { useSyncExternalStore } from 'react';
import { Button } from '../../ui/Button';
import { TransferView } from '../transfer/TransferView';
import type { LinkSnapshot } from './link';
import type { Session } from './session';

const ENDED: Record<NonNullable<LinkSnapshot['notice']>, (name: string) => string> = {
  declined: (name) => `${name} declined the connection.`,
  unavailable: (name) =>
    `The connection could not be set up. ${name} may have left, or your networks may not allow a direct connection.`,
  expired: () => 'The request expired before it was answered.',
  canceled: () => 'The connection was canceled.',
};

const TERMINAL = ['completed', 'rejected', 'canceled', 'failed'];

function SessionPanel({
  session,
  role,
  onDismiss,
}: {
  session: Session;
  role: LinkSnapshot['role'];
  onDismiss: () => void;
}) {
  const { state } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return (
    <>
      <TransferView session={session} direction={role === 'offerer' ? 'send' : 'receive'} />
      {TERMINAL.includes(state) && (
        <Button className="mt-6" onClick={onDismiss}>
          Close
        </Button>
      )}
    </>
  );
}

/** Progress of the current connection attempt; the transfer itself is rendered by TransferView. */
export function ConnectionPanel({
  link,
  onCancel,
  onDismiss,
}: {
  link: LinkSnapshot;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (link.phase === 'session' && link.session) {
    return <SessionPanel session={link.session} role={link.role} onDismiss={onDismiss} />;
  }
  const name = link.peerName ?? 'The other device';
  const view =
    link.phase === 'requesting'
      ? {
          text: `Waiting for ${name} to accept the connection…`,
          button: 'Cancel request',
          action: onCancel,
        }
      : link.phase === 'connecting'
        ? { text: `Connecting directly to ${name}…`, button: 'Cancel', action: onCancel }
        : link.phase === 'ended' && link.notice
          ? { text: ENDED[link.notice](name), button: 'Close', action: onDismiss }
          : null;
  if (!view) return null;
  return (
    <div>
      <p role="status" className="text-[15px]">
        {view.text}
      </p>
      <Button className="mt-6" onClick={view.action}>
        {view.button}
      </Button>
    </div>
  );
}
