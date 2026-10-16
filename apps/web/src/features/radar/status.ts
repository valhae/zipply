import type { DiscoveryStatus } from './StatusBadge';

export type Connection = 'connecting' | 'online' | 'offline' | 'reconnecting';

export function discoveryStatus(connection: Connection, discoverable: boolean): DiscoveryStatus {
  if (connection !== 'online') return connection;
  return discoverable ? 'visible' : 'invisible';
}
