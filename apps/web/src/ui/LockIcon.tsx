/** Small monochrome lock (decorative; pair it with text). */
export function LockIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg
      data-icon="lock"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`inline-block shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
