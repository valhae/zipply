import { Chip } from '../../ui/Chip';
import { STATE_LABELS } from './labels';
import type { RadarPeer } from './types';

interface Props {
  peers: RadarPeer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PeerList({ peers, selectedId, onSelect }: Props) {
  if (peers.length === 0) {
    return (
      <p className="border-y border-gray-200 py-6 text-center text-[13px] text-gray-500">
        No one is discoverable here right now.
      </p>
    );
  }
  return (
    <ul
      aria-label="Discoverable people"
      className="divide-y divide-gray-200 border-y border-gray-200"
    >
      {peers.map((peer) => (
        <li key={peer.id}>
          <button
            type="button"
            aria-pressed={peer.id === selectedId}
            onClick={() => onSelect(peer.id)}
            className="flex min-h-12 w-full min-w-0 items-center justify-between gap-4 py-2 text-left transition-colors duration-200 hover:bg-gray-50 aria-pressed:font-semibold"
          >
            <span className="min-w-0 truncate" title={peer.name}>
              {peer.id === selectedId && <span aria-hidden="true">→ </span>}
              {peer.name}
            </span>
            <Chip inverted={peer.state === 'connected'}>{STATE_LABELS[peer.state]}</Chip>
          </button>
        </li>
      ))}
    </ul>
  );
}
