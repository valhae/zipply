import { useState } from 'react';
import { Button } from '../../ui/Button';
import { LockIcon } from '../../ui/LockIcon';
import type { Room } from './room';

interface Props {
  room: Room | null;
  invalid: boolean;
  onCreate: () => void;
  onLeave: () => void;
}

/** Private rooms: the capability travels only in the link's fragment, never to a server path or log. */
export function RoomControl({ room, invalid, onCreate, onLeave }: Props) {
  const [copied, setCopied] = useState(false);
  const link = room ? `${location.origin}${location.pathname}#room=${room.capability}` : '';
  const expires = room
    ? new Date(room.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="mt-4 rounded-2xl border border-gray-200 p-5">
      <p className="flex items-center gap-1.5 font-medium">
        <LockIcon /> Private room
      </p>
      {invalid ? (
        <p role="alert" className="mt-2 text-[13px] text-gray-600">
          This room link is invalid or has expired. Ask for a new link, or go back to the lobby.
        </p>
      ) : room ? (
        <>
          <p className="mt-2 text-[13px] text-gray-600">
            Only people with this link see each other here. Link expires at {expires}.
          </p>
          <label className="mt-3 grid gap-1 text-[13px]">
            <span className="micro text-[10px] text-gray-500">Room link</span>
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="min-h-11 w-full rounded-md border border-gray-200 bg-bg px-3 font-mono text-[12px]"
            />
          </label>
          <Button
            className="mt-3 w-full"
            onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-gray-600">
          Make a link that only works for 30 minutes. People in a private room don’t see the public
          lobby.
        </p>
      )}
      {room || invalid ? (
        <Button className="mt-3 w-full" onClick={onLeave}>
          Leave room
        </Button>
      ) : (
        <Button className="mt-3 w-full" onClick={onCreate}>
          Create private room
        </Button>
      )}
    </div>
  );
}
