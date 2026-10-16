import type { ReactNode } from 'react';

export function SectionHeader({
  id,
  index,
  title,
  meta,
}: {
  id: string;
  index: string;
  title: string;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-6 flex h-8 items-center justify-between gap-4 border-b border-gray-200">
      <h2 id={id} className="micro font-pixel text-gray-600">
        {index} — {title}
      </h2>
      {meta && <span className="micro truncate text-[10px] text-gray-500">{meta}</span>}
    </div>
  );
}
