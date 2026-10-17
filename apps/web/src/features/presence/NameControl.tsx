import { isValidDisplayName } from '@zipply/protocol';
import { useState } from 'react';
import { Button } from '../../ui/Button';

interface Props {
  name: string;
  /** The user chose this name (otherwise it is this visit's auto name). */
  custom: boolean;
  /** A visible peer here already uses it, so the server keeps this user hidden. */
  taken: boolean;
  /** A connection or transfer is in progress: renaming would reconnect and end it. */
  busy: boolean;
  onChange: (name: string) => void;
  onRandom: () => void;
}

/** The temporary name others see. A label only, never proof of identity. */
export function NameControl({ name, custom, taken, busy, onChange, onRandom }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const save = () => {
    const next = (draft ?? '').trim().normalize('NFC');
    if (!isValidDisplayName(next)) return setError(true);
    onChange(next);
    setDraft(null);
    setError(false);
  };

  if (draft !== null) {
    return (
      <form
        className="mt-4 grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="grid gap-1 text-[13px]">
          <span className="micro text-[10px] text-gray-500">Display name</span>
          <input
            // Focus follows the user's Edit click, so keyboard users land in the field.
            ref={(el) => el?.focus()}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={error}
            aria-describedby={error ? 'name-error' : undefined}
            className="min-h-11 w-full rounded-md border border-gray-200 bg-bg px-3 text-[15px]"
          />
        </label>
        {error && (
          <p id="name-error" role="alert" className="text-[13px] text-gray-600">
            Use one word of 1–32 characters: no spaces, line breaks or hidden formatting characters.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button type="submit" variant="primary">
            Save name
          </Button>
          <Button
            onClick={() => {
              setDraft(null);
              setError(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="mt-4">
      <p className="text-[13px] text-gray-600">
        Others see you as <span className="font-medium text-ink">{name}</span>. A name is only a
        label, not proof of who you are.
      </p>
      {taken && (
        <p role="alert" className="mt-2 text-[13px] text-gray-600">
          Someone visible here already uses this name, so you stay hidden. Pick another name to
          become discoverable.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => setDraft(name)}>
          Edit name
        </Button>
        {custom && (
          <Button disabled={busy} onClick={onRandom}>
            Random name
          </Button>
        )}
      </div>
      {busy && (
        <p className="mt-2 text-[13px] text-gray-600">
          You can change your name when no connection is in progress.
        </p>
      )}
    </div>
  );
}
