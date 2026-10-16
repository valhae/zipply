import type { PeerState } from './types';

export const STATE_LABELS: Record<PeerState, string> = {
  available: 'Available',
  pending: 'Request pending',
  connected: 'Connected',
};
