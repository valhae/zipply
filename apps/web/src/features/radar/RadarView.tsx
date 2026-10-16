import { MAX_RADAR_MARKERS, RING_RADII, placePeers } from './layout';
import type { RadarPeer } from './types';

const LABEL_LIMIT = 8;
const shorten = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);
const HAIRLINE = { strokeWidth: 1, vectorEffect: 'non-scaling-stroke' } as const;

interface Props {
  peers: RadarPeer[];
  selectedId: string | null;
  scanning?: boolean;
}

// Decorative mirror of PeerList (aria-hidden); position never encodes distance.
export function RadarView({ peers, selectedId, scanning = true }: Props) {
  const markers = placePeers(peers);
  const showLabels = peers.length <= LABEL_LIMIT;
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[min(100%,22rem,58svh)]">
      {scanning && (
        <div
          aria-hidden="true"
          data-testid="radar-sweep"
          className="sweep absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,transparent_0deg_300deg,color-mix(in_srgb,var(--color-ink)_12%,transparent)_360deg)]"
        />
      )}
      <svg
        viewBox="-1 -1 2 2"
        aria-hidden="true"
        data-testid="radar"
        className="relative size-full overflow-visible font-mono"
      >
        {RING_RADII.map((r) => (
          <circle
            key={r}
            r={r}
            fill="none"
            stroke={r === 1 ? 'var(--color-gray-300)' : 'var(--color-gray-200)'}
            {...HAIRLINE}
          />
        ))}
        <path d="M-1 0H1M0 -1V1" stroke="var(--color-gray-200)" {...HAIRLINE} />
        <circle r="0.015" fill="var(--color-ink)" />
        {markers.map(({ peer, x, y }) => {
          const selected = peer.id === selectedId;
          const filled = selected || peer.state === 'connected';
          return (
            <g
              key={peer.id}
              data-testid="radar-marker"
              data-peer-id={peer.id}
              data-state={peer.state}
            >
              {peer.state === 'pending' && (
                <circle
                  cx={x}
                  cy={y}
                  r="0.055"
                  fill="none"
                  stroke="var(--color-ink)"
                  {...HAIRLINE}
                />
              )}
              <circle
                cx={x}
                cy={y}
                r={selected ? 0.034 : 0.026}
                fill={filled ? 'var(--color-ink)' : 'var(--color-bg)'}
                stroke="var(--color-ink)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              {(showLabels || selected) && (
                <text
                  x={x}
                  y={y + 0.11}
                  textAnchor="middle"
                  fontSize="0.055"
                  fill={selected ? 'var(--color-ink)' : 'var(--color-gray-600)'}
                  fontWeight={selected ? 600 : 400}
                >
                  {shorten(peer.name)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {peers.length > MAX_RADAR_MARKERS && (
        <p className="micro absolute inset-x-0 -bottom-7 text-center text-[10px] text-gray-500">
          +{peers.length - MAX_RADAR_MARKERS} more in the list
        </p>
      )}
    </div>
  );
}
