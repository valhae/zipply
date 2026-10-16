import type { RadarPeer } from './types';

export const MAX_RADAR_MARKERS = 24;
export const RING_RADII = [0.25, 0.5, 0.75, 1];
const ORBITS = [0.5, 0.75];
const SLOTS_PER_ORBIT = 24; // 15° apart; the outer orbit is offset by 7.5°.

export interface RadarMarker {
  peer: RadarPeer;
  x: number;
  y: number;
}

// FNV-1a: stable, cheap; placement is decorative, not a distance.
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function placePeers(peers: readonly RadarPeer[]): RadarMarker[] {
  const total = ORBITS.length * SLOTS_PER_ORBIT;
  const taken = new Set<number>();
  return peers.slice(0, MAX_RADAR_MARKERS).map((peer) => {
    let slot = hash(peer.id) % total;
    while (taken.has(slot)) slot = (slot + 1) % total;
    taken.add(slot);
    const orbit = Math.floor(slot / SLOTS_PER_ORBIT);
    const r = ORBITS[orbit]!;
    const angle = (((slot % SLOTS_PER_ORBIT) * 15 + orbit * 7.5 - 90) * Math.PI) / 180;
    return { peer, x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
}
