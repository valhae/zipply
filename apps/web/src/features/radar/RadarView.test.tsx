import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadarView } from './RadarView';

afterEach(cleanup);

const peers = [
  { id: 'a', name: 'VoxlByte', state: 'available' as const },
  { id: 'b', name: 'Mar', state: 'pending' as const },
];

describe('RadarView', () => {
  it('selects a peer when its dot is clicked (pointer shortcut for the list)', () => {
    const onSelect = vi.fn();
    render(<RadarView peers={peers} selectedId={null} onSelect={onSelect} />);
    const marker = screen.getAllByTestId('radar-marker').find((m) => m.dataset.peerId === 'b')!;
    fireEvent.click(marker);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('pings each dot when the beam passes it', () => {
    render(<RadarView peers={peers} selectedId={null} onSelect={() => {}} />);
    for (const m of screen.getAllByTestId('radar-marker')) {
      expect(m.querySelector('.ping')).not.toBeNull();
    }
  });
});
