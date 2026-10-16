import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { STATE_LABELS } from './labels';
import type { RadarPeer } from './types';

export function PeerDetails({ peer, onClose }: { peer: RadarPeer | null; onClose: () => void }) {
  return (
    <Dialog open={peer !== null} onClose={onClose} title={peer?.name ?? ''}>
      <p className="micro text-gray-600">{peer && STATE_LABELS[peer.state]}</p>
      <p className="mt-4 text-[13px] text-gray-600">
        A display name is only a label, not a verified identity. Before any file is shared you will
        both compare a short verification phrase.
      </p>
      <div className="mt-6 grid gap-3">
        <Button variant="primary" disabled aria-describedby="request-note">
          Request connection
        </Button>
        <p id="request-note" className="text-[13px] text-gray-600">
          Connection requests are not available yet.
        </p>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}
