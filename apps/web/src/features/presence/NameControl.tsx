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
  const editing = draft !== null;

  const save = () => {
    const next = (draft ?? '').trim().normalize('NFC');
    if (!isValidDisplayName(next)) return setError(true);
    onChange(next);
    setDraft(null);
    setError(false);
  };
  const cancel = () => {
    setDraft(null);
    setError(false);
  };

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label htmlFor="display-name" className="micro text-[10px] text-gray-500">
        Display name
      </label>
      <div className="flex gap-2">
        <input
          id="display-name"
          // Focus follows the user's Edit click, so keyboard users land in the field.
          ref={editing ? (el) => el?.focus() : undefined}
          readOnly={!editing}
          value={draft ?? name}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && editing && cancel()}
          aria-invalid={error}
          aria-describedby={error ? 'name-error' : undefined}
          className="min-h-11 w-full min-w-0 rounded-md border border-gray-200 bg-bg px-3 text-[15px] font-medium read-only:bg-gray-50"
        />
        {!editing && (
          <Button
            aria-label="Edit name"
            disabled={busy}
            onClick={() => setDraft(name)}
            className="shrink-0 px-3"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
            </svg>
            Edit
          </Button>
        )}
      </div>
      {error && (
        <p id="name-error" role="alert" className="text-[13px] text-gray-600">
          Use one word of 1–32 characters: no spaces, line breaks or hidden formatting characters.
        </p>
      )}
      {editing ? (
        <div className="grid grid-cols-2 gap-2">
          <Button type="submit" variant="primary">
            Save name
          </Button>
          <Button onClick={cancel}>Cancel</Button>
        </div>
      ) : (
        <>
          <p className="text-[13px] text-gray-600">
            Others see this name. It is only a label, not proof of who you are.
          </p>
          {taken && (
            <p role="alert" className="text-[13px] text-gray-600">
              Someone visible here already uses this name, so you stay hidden. Pick another name to
              become discoverable.
            </p>
          )}
          {custom && (
            <Button disabled={busy} onClick={onRandom} className="justify-self-start">
              Random name
            </Button>
          )}
          {busy && (
            <p className="text-[13px] text-gray-600">
              You can change your name when no connection is in progress.
            </p>
          )}
        </>
      )}
    </form>
  );
}
