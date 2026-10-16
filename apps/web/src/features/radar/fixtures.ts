import type { Connection } from './status';
import type { RadarPeer } from './types';

// Dev-only demo data (`?demo=...`). Must never ship in production builds.
const FEW: RadarPeer[] = [
  { id: 'demo-a1', name: 'Alex’s laptop', state: 'available' },
  { id: 'demo-b2', name: 'Pixel 9', state: 'pending' },
  { id: 'demo-c3', name: 'Studio iMac', state: 'connected' },
];

const TRICKY: RadarPeer[] = [
  {
    id: 'demo-long',
    name: 'An extremely long display name that keeps going and going without spaces_xxxxxxxx',
    state: 'available',
  },
  { id: 'demo-html', name: '<img src=x onerror=alert(1)>', state: 'available' },
  { id: 'demo-unicode', name: 'Bücherwurm 📚 Ünïcødé', state: 'pending' },
  { id: 'demo-rtl', name: 'مرحبا بالعالم', state: 'available' },
];

const CONNECTIONS: Connection[] = ['connecting', 'online', 'offline', 'reconnecting'];

export interface DemoState {
  peers: RadarPeer[];
  connection: Connection;
}

export function readDemo(search: string): DemoState | null {
  const params = new URLSearchParams(search);
  const demo = params.get('demo');
  if (!demo) return null;
  const peers =
    demo === 'few'
      ? FEW
      : demo === 'tricky'
        ? TRICKY
        : demo === 'many'
          ? Array.from({ length: 30 }, (_, i) => ({
              id: `demo-m${i}`,
              name: `Device ${i + 1}`,
              state: (['available', 'pending', 'connected'] as const)[i % 3]!,
            }))
          : [];
  const connection = CONNECTIONS.find((c) => c === params.get('connection')) ?? 'online';
  return { peers, connection };
}
