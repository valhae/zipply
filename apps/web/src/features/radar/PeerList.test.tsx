import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PeerList } from './PeerList';

afterEach(cleanup);

const peers = [
  { id: 'a', name: 'Voxl27', state: 'available' as const },
  { id: 'b', name: 'Mar', state: 'pending' as const },
];

describe('PeerList', () => {
  it('marks every person with a lock while in a private room (icon + text for screen readers)', () => {
    render(<PeerList peers={peers} selectedId={null} onSelect={() => {}} locked />);
    for (const name of ['Voxl27', 'Mar']) {
      const item = screen.getByRole('button', { name: new RegExp(name) });
      expect(within(item).getByText('Private room:')).toBeTruthy();
      expect(item.querySelector('svg[data-icon="lock"]')).toBeTruthy();
    }
  });

  it('shows no lock in the public lobby', () => {
    const { container } = render(<PeerList peers={peers} selectedId={null} onSelect={() => {}} />);
    expect(container.querySelector('svg[data-icon="lock"]')).toBeNull();
    expect(screen.queryByText('Private room:')).toBeNull();
  });
});
