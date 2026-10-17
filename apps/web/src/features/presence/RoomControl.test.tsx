import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomControl } from './RoomControl';

afterEach(cleanup);

const room = {
  capability: 'AAECAwQFBgcICQoLDA0ODxAREhM',
  hash: 'h',
  expiresAt: Date.UTC(2026, 9, 17, 14, 30),
};

describe('RoomControl', () => {
  it('offers to create a private room', () => {
    const onCreate = vi.fn();
    render(<RoomControl room={null} invalid={false} onCreate={onCreate} onLeave={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('shows the share link (capability only in the fragment) and lets you leave', () => {
    const onLeave = vi.fn();
    render(<RoomControl room={room} invalid={false} onCreate={() => {}} onLeave={onLeave} />);
    const link = screen.getByLabelText('Room link') as HTMLInputElement;
    expect(link.value).toBe(`${location.origin}${location.pathname}#room=${room.capability}`);
    expect(link.readOnly).toBe(true);
    expect(screen.getByText(/Link expires/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('explains an invalid or expired room link', () => {
    render(<RoomControl room={null} invalid onCreate={() => {}} onLeave={() => {}} />);
    expect(screen.getByText(/invalid or has expired/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave room' })).toBeTruthy();
  });
});
