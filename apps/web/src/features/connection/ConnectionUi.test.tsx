import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionPanel } from './ConnectionPanel';
import { IDLE_LINK, type LinkSnapshot } from './link';
import { RequestDialog } from './RequestDialog';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(cleanup);

const link = (patch: Partial<LinkSnapshot>): LinkSnapshot => ({
  ...IDLE_LINK,
  peerName: 'Alex',
  ...patch,
});

describe('RequestDialog', () => {
  it('shows only the sender label and the two connection choices', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render(
      <RequestDialog
        link={link({ phase: 'incoming' })}
        onAccept={onAccept}
        onDecline={onDecline}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connection request' });
    expect(dialog.textContent).toContain('Alex wants to connect');
    expect(dialog.textContent).toMatch(/not a verified identity/);
    expect(dialog.textContent).toMatch(/network address/);
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Accept connection', 'Reject connection']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept connection' }));
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject connection' }));
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it('renders the sender label as text', () => {
    render(
      <RequestDialog
        link={link({ phase: 'incoming', peerName: '<img src=x>' })}
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
  });

  it('is closed outside the incoming phase', () => {
    render(
      <RequestDialog
        link={link({ phase: 'requesting' })}
        onAccept={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ConnectionPanel', () => {
  it.each([
    ['requesting', /Waiting for Alex to accept/, 'Cancel request'],
    ['connecting', /Connecting directly to Alex/, 'Cancel'],
  ] as const)('%s shows its status and a cancel control', (phase, text, button) => {
    const onCancel = vi.fn();
    render(<ConnectionPanel link={link({ phase })} onCancel={onCancel} onDismiss={() => {}} />);
    expect(screen.getByRole('status').textContent).toMatch(text);
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['declined', /Alex declined/],
    ['unavailable', /could not be set up/],
    ['expired', /expired/],
    ['canceled', /canceled/],
  ] as const)('explains an ended attempt (%s) and can be closed', (notice, text) => {
    const onDismiss = vi.fn();
    render(
      <ConnectionPanel
        link={link({ phase: 'ended', notice })}
        onCancel={() => {}}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(text);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders nothing while idle or while a request is incoming', () => {
    const { container } = render(
      <>
        <ConnectionPanel link={link({ phase: 'idle' })} onCancel={() => {}} onDismiss={() => {}} />
        <ConnectionPanel
          link={link({ phase: 'incoming' })}
          onCancel={() => {}}
          onDismiss={() => {}}
        />
      </>,
    );
    expect(container.textContent).toBe('');
  });
});
