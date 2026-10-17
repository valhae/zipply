import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PeerDetails } from './PeerDetails';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const peer = { id: 'p1', name: 'Alex', state: 'available' as const };

describe('PeerDetails', () => {
  it('requests a connection only after files are chosen, and keeps files local', () => {
    const onRequest = vi.fn();
    render(<PeerDetails peer={peer} canRequest onRequest={onRequest} onClose={() => {}} />);
    const button = screen.getByRole('button', { name: 'Request connection' });
    expect(button).toHaveProperty('disabled', true);
    const file = new File(['x'], 'secret.txt');
    fireEvent.change(screen.getByLabelText('Files to send'), { target: { files: [file] } });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    expect(onRequest).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it('explains that requests need online discovery', () => {
    render(<PeerDetails peer={peer} canRequest={false} onRequest={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Request connection' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/needs online discovery/)).toBeTruthy();
  });

  it('discloses that a direct connection shares the network address', () => {
    render(<PeerDetails peer={peer} canRequest onRequest={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/network address/)).toBeTruthy();
  });
});
