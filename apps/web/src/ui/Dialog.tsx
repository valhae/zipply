import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

// Native modal <dialog>: focus trap, Escape and focus return come from the browser.
// Below 640px it renders as a bottom sheet.
export function Dialog({ open, onClose, title, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-0 mt-auto w-full max-w-none rounded-t-2xl border border-gray-200 bg-bg p-0 text-ink shadow-modal backdrop:bg-ink/30 backdrop:backdrop-blur-sm open:animate-[fade-up_200ms_var(--ease-out-soft)] sm:m-auto sm:max-w-sm sm:rounded-2xl"
    >
      <div className="max-h-[85svh] overflow-y-auto p-7 pb-[max(1.75rem,env(safe-area-inset-bottom))]">
        <h2 id={titleId} className="mb-3 text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
