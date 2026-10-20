import { useState } from 'react';
import { MAX_RADAR_MARKERS, RING_RADII, placePeers } from './layout';
import type { RadarPeer } from './types';

const LABEL_LIMIT = 8;
const SWEEP_MS = 4000; // keep in sync with the `sweep` and `ping` utilities in styles.css
const shorten = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);
const HAIRLINE = { strokeWidth: 1, vectorEffect: 'non-scaling-stroke' } as const;

/**
 * Animation delay that phase-locks a SWEEP_MS loop to the page clock, so a dot mounted later still
 * pings exactly when the beam passes it. `offsetMs` is where in the loop the element fires.
 */
function useSynced(offsetMs = 0) {
  const [mountedAt] = useState(() => performance.now());
  return `${offsetMs - (mountedAt % SWEEP_MS)}ms`;
}

function Beam() {
  return (
    <div
      aria-hidden="true"
      data-testid="radar-sweep"
      style={{ animationDelay: useSynced() }}
      className="sweep absolute inset-0 overflow-hidden rounded-full will-change-transform bg-[conic-gradient(from_0deg,transparent_0deg_300deg,color-mix(in_srgb,var(--color-ink)_12%,transparent)_360deg)]"
    >
      <div className="beam-dots absolute inset-0" />
    </div>
  );
}

interface MarkerProps {
  peer: RadarPeer;
  x: number;
  y: number;
  selected: boolean;
  label: boolean;
  onSelect: (id: string) => void;
}

function Marker({ peer, x, y, selected, label, onSelect }: MarkerProps) {
  // Clockwise angle from the top, where the beam starts each loop.
  const angle = (Math.atan2(y, x) * 180) / Math.PI + 90;
  const delay = useSynced((((angle + 360) % 360) / 360) * SWEEP_MS);
  const filled = selected || peer.state === 'connected';
  return (
    <g
      data-testid="radar-marker"
      data-peer-id={peer.id}
      data-state={peer.state}
      onClick={() => onSelect(peer.id)}
      className="cursor-pointer"
    >
      {/* Invisible hit area: the dot alone is too small to tap. */}
      <circle cx={x} cy={y} r="0.1" fill="transparent" />
      <circle
        cx={x}
        cy={y}
        r="0.03"
        fill="none"
        stroke="var(--color-ink)"
        style={{ animationDelay: delay }}
        className="ping"
        {...HAIRLINE}
      />
      {peer.state === 'pending' && (
        <circle cx={x} cy={y} r="0.055" fill="none" stroke="var(--color-ink)" {...HAIRLINE} />
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
      {label && (
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
}

interface Props {
  peers: RadarPeer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  scanning?: boolean;
}

// Decorative mirror of PeerList (aria-hidden): dots are a pointer shortcut, the list is the
// keyboard and screen-reader path. Position never encodes distance.
export function RadarView({ peers, selectedId, onSelect, scanning = true }: Props) {
  const markers = placePeers(peers);
  const showLabels = peers.length <= LABEL_LIMIT;
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[min(100%,30rem,62svh)]">
      {scanning && <Beam />}
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
        {markers.map(({ peer, x, y }) => (
          <Marker
            key={peer.id}
            peer={peer}
            x={x}
            y={y}
            selected={peer.id === selectedId}
            label={showLabels || peer.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </svg>
      {peers.length > MAX_RADAR_MARKERS && (
        <p className="micro absolute inset-x-0 -bottom-7 text-center text-[10px] text-gray-500">
          +{peers.length - MAX_RADAR_MARKERS} more in the list
        </p>
      )}
    </div>
  );
}
