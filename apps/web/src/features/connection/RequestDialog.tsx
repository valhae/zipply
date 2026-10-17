import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { LinkSnapshot } from './link';

/** An incoming connection request: sender label only, no file details (they come after the SAS). */
export function RequestDialog({
  link,
  onAccept,
  onDecline,
}: {
  link: LinkSnapshot;
  onAccept: () => void;
  onDecline: () => void;
}) {
  // Closing (Escape) declines; decline() is a no-op once the request was accepted.
  return (
    <Dialog open={link.phase === 'incoming'} onClose={onDecline} title="Connection request">
      <p className="text-[15px]">{link.peerName} wants to connect.</p>
      <p className="mt-3 text-[13px] text-gray-600">
        A name is not a verified identity. If you accept, you both compare six words before any file
        details are shared, and you decide on the files after that. A direct connection shares your
        network address (IP) with the other device.
      </p>
      <div className="mt-6 grid gap-3">
        <Button variant="primary" onClick={onAccept}>
          Accept connection
        </Button>
        <Button onClick={onDecline}>Reject connection</Button>
      </div>
    </Dialog>
  );
}
