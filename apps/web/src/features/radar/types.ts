export type PeerState = 'available' | 'pending' | 'connected';

export interface RadarPeer {
  id: string;
  name: string;
  state: PeerState;
}
