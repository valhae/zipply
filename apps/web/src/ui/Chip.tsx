import type { ReactNode } from 'react';

export function Chip({ children, inverted = false }: { children: ReactNode; inverted?: boolean }) {
  return (
    <span
      className={`micro inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] ${
        inverted ? 'bg-ink text-bg' : 'border border-gray-300 text-gray-600'
      }`}
    >
      {children}
    </span>
  );
}
