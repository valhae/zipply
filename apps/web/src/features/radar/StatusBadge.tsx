export type DiscoveryStatus = 'connecting' | 'visible' | 'invisible' | 'offline' | 'reconnecting';

const LABELS: Record<DiscoveryStatus, string> = {
  connecting: 'Connecting',
  visible: 'Visible',
  invisible: 'Invisible',
  offline: 'Offline',
  reconnecting: 'Reconnecting',
};

export function StatusBadge({ status }: { status: DiscoveryStatus }) {
  const busy = status === 'connecting' || status === 'reconnecting';
  return (
    <p
      role="status"
      className="micro inline-flex h-8 items-center gap-2 rounded-full border border-gray-200 px-3 text-[10px] text-gray-600"
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${status === 'visible' ? 'bg-ink' : 'ring-1 ring-ink ring-inset'} ${busy ? 'pulse' : ''}`}
      />
      <span>{LABELS[status]}</span>
    </p>
  );
}
