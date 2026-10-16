import { describe, expect, it } from 'vitest';
import { MAX_RADAR_MARKERS, RING_RADII, placePeers } from './layout';
import type { RadarPeer } from './types';

const peer = (id: string): RadarPeer => ({ id, name: `peer ${id}`, state: 'available' });
const many = (n: number) => Array.from({ length: n }, (_, i) => peer(`p${i}`));

describe('placePeers', () => {
  it('places every peer inside the unit circle, away from the centre', () => {
    const placed = placePeers(many(MAX_RADAR_MARKERS));
    expect(placed).toHaveLength(MAX_RADAR_MARKERS);
    for (const { x, y } of placed) {
      const r = Math.hypot(x, y);
      expect(r).toBeGreaterThan(0.2);
      expect(r).toBeLessThanOrEqual(0.9);
    }
  });

  it('puts every marker exactly on a drawn ring', () => {
    for (const { x, y } of placePeers(many(MAX_RADAR_MARKERS))) {
      const r = Math.hypot(x, y);
      expect(RING_RADII.some((ring) => Math.abs(ring - r) < 1e-9)).toBe(true);
    }
  });

  it('is deterministic for the same peer id', () => {
    const first = placePeers([peer('abc')]);
    expect(first).toHaveLength(1);
    expect(first).toEqual(placePeers([peer('abc')]));
  });

  it('keeps earlier peers in place when later peers join', () => {
    const before = placePeers(many(5));
    const after = placePeers(many(20)).slice(0, 5);
    expect(before).toHaveLength(5);
    expect(after).toEqual(before);
  });

  it.each(['p', 'demo-m', 'peer-', 'x'])('keeps markers apart for ids prefixed %s', (prefix) => {
    const placed = placePeers(
      Array.from({ length: MAX_RADAR_MARKERS }, (_, i) => peer(`${prefix}${i}`)),
    );
    for (const [i, a] of placed.entries()) {
      for (const b of placed.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(0.12);
      }
    }
  });

  it('aligns markers to 7.5 degree slots', () => {
    for (const { x, y } of placePeers(many(MAX_RADAR_MARKERS))) {
      const deg = (Math.atan2(y, x) * 180) / Math.PI;
      expect(Math.abs(deg / 7.5 - Math.round(deg / 7.5))).toBeLessThan(1e-9);
    }
  });

  it('spreads different ids to different positions', () => {
    const [a, b] = placePeers([peer('alpha'), peer('bravo')]);
    expect(a && b && (a.x !== b.x || a.y !== b.y)).toBe(true);
  });

  it(`caps markers at ${MAX_RADAR_MARKERS}, keeping list order`, () => {
    const placed = placePeers(many(MAX_RADAR_MARKERS + 5));
    expect(placed).toHaveLength(MAX_RADAR_MARKERS);
    expect(placed.map((m) => m.peer.id)).toEqual(many(MAX_RADAR_MARKERS).map((p) => p.id));
  });
});
