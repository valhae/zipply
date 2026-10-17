import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { STATE_LABELS } from './labels';
import type { RadarPeer } from './types';

interface Props {
  peer: RadarPeer | null;
  canRequest: boolean;
  onRequest: (files: File[]) => void;
  onClose: () => void;
}

export function PeerDetails({ peer, canRequest, onRequest, onClose }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const close = () => {
    setFiles([]);
    onClose();
  };
  return (
    <Dialog open={peer !== null} onClose={close} title={peer?.name ?? ''}>
      <p className="micro text-gray-600">{peer && STATE_LABELS[peer.state]}</p>
      <p className="mt-4 text-[13px] text-gray-600">
        A display name is only a label, not a verified identity. Before any file is shared you will
        both compare a short verification phrase. A direct connection shares your network address
        (IP) with the other device.
      </p>
      <div className="mt-6 grid gap-3">
        <label className="grid gap-2 text-[13px]">
          Files to send
          <input
            type="file"
            multiple
            disabled={!canRequest}
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
            className="text-[13px]"
          />
        </label>
        <Button
          variant="primary"
          disabled={!canRequest || files.length === 0}
          aria-describedby={canRequest ? undefined : 'request-note'}
          onClick={() => {
            onRequest(files);
            close();
          }}
        >
          Request connection
        </Button>
        {!canRequest && (
          <p id="request-note" className="text-[13px] text-gray-600">
            Sending a request needs online discovery, and no other connection in progress.
          </p>
        )}
        <Button onClick={close}>Close</Button>
      </div>
    </Dialog>
  );
}
