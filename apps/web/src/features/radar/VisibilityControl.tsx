import { useState } from 'react';
import { Dialog } from '../../ui/Dialog';

interface Props {
  discoverable: boolean;
  online: boolean;
  onChange: (discoverable: boolean) => void;
}

export function VisibilityControl({ discoverable, online, onChange }: Props) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5 shadow-card">
      <div className="flex items-center justify-between gap-4">
        <span id="visibility-label" className="font-medium">
          Discoverable
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={discoverable}
          aria-labelledby="visibility-label"
          onClick={() => onChange(!discoverable)}
          className="group -mr-1.5 flex h-11 w-14 shrink-0 items-center justify-center rounded-full"
        >
          <span
            aria-hidden="true"
            className={`flex h-6 w-11 items-center rounded-full p-0.5 transition-colors duration-200 ${discoverable ? 'bg-ink' : 'bg-gray-200'}`}
          >
            <span
              className={`size-5 rounded-full shadow-sm transition-transform duration-200 ease-(--ease-out-soft) ${discoverable ? 'translate-x-5 bg-bg' : 'bg-gray-500'}`}
            />
          </span>
        </button>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-gray-600">
        {!discoverable
          ? 'You are hidden. You can still see people who chose to be discoverable.'
          : online
            ? 'Others in this online lobby can see your temporary name.'
            : 'You will become visible once discovery is connected.'}
      </p>
      <div className="mt-4 border-t border-gray-200 pt-3">
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="micro -mx-1 inline-flex min-h-11 items-center gap-1.5 px-1 text-[10px] text-gray-600 transition-colors hover:text-ink"
        >
          What does this share <span aria-hidden="true">→</span>
        </button>
      </div>
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Visibility">
        <div className="space-y-3 text-[15px] text-gray-700">
          <p>
            Turning on Discoverable shows your temporary name to everyone connected to the same
            online lobby. The lobby is not based on location, so people listed may be anywhere.
          </p>
          <p>
            Zipply never shows your IP address or location. Turn this off at any time to disappear
            from the list.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setHelpOpen(false)}
          className="micro mt-6 min-h-11 w-full rounded-lg bg-ink px-4 text-bg"
        >
          Close
        </button>
      </Dialog>
    </div>
  );
}
