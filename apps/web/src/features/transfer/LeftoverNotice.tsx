import { useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
import { leftovers } from './sinks';
import { formatBytes } from './TransferView';

type Found = Awaited<ReturnType<typeof leftovers>>;
const findLeftovers = () => leftovers();

/** D22: partial received data left in browser storage by an earlier visit; it cannot be resumed. */
export function LeftoverNotice({ find = findLeftovers }: { find?: () => Promise<Found> }) {
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    // No cancellation: a second scan running at the same time finds the folders locked by the
    // first and reports nothing, so the first result must not be dropped.
    find()
      .then((f) => f.bytes > 0 && setFound(f))
      .catch(() => {}); // no browser storage here: nothing to clean up
  }, [find]);
  if (!found) return null;
  return (
    <div role="note" className="mt-6 rounded-2xl border border-gray-200 p-5 text-[13px]">
      <p>
        Unfinished received files from an earlier visit are using {formatBytes(found.bytes)} of this
        browser&apos;s storage. They cannot be resumed.
      </p>
      <Button
        className="mt-4"
        onClick={() =>
          void found
            .remove()
            .catch(() => {})
            .then(() => setFound(null))
        }
      >
        Delete it
      </Button>
    </div>
  );
}
