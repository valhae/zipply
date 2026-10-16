import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../connection/session';
import { TransferView } from './TransferView';

beforeAll(() => {
  // jsdom has no modal dialog support.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  // Like browsers: close() fires a 'close' event.
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(cleanup);

const PHRASE = ['apple', 'banana', 'cherry', 'delta', 'echo', 'fox'];
const base: Snapshot = {
  state: 'verifying',
  phrase: PHRASE,
  localConfirmed: false,
  manifest: null,
  tooLarge: false,
  progress: null,
  downloads: [],
};

function fakeSession(patch: Partial<Snapshot>) {
  let snap = { ...base, ...patch };
  const listeners = new Set<() => void>();
  return {
    set: (next: Partial<Snapshot>) => {
      snap = { ...snap, ...next };
      listeners.forEach((fn) => fn());
    },
    getSnapshot: () => snap,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    confirm: vi.fn(),
    mismatch: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    lost: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('TransferView: verification', () => {
  it('shows the six words with only Match and Mismatch controls (no skip path)', () => {
    const s = fakeSession({});
    render(<TransferView session={s} direction="receive" />);
    const dialog = screen.getByRole('dialog', { name: 'Verification required' });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(PHRASE.map((w, i) => `${i + 1}${w}`));
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual(['The words match', 'Mismatch — cancel']);
    expect(screen.queryByRole('button', { name: /skip|continue|trust/i })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'The words match' }));
    expect(s.confirm).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mismatch — cancel' }));
    expect(s.mismatch).toHaveBeenCalledOnce();
  });

  it('waits for the other person after a local confirmation', () => {
    render(<TransferView session={fakeSession({ localConfirmed: true })} direction="send" />);
    expect(screen.queryByRole('button', { name: 'The words match' })).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Verification required' });
    expect(within(dialog).getByText(/Waiting for the other person to confirm/)).toBeTruthy();
  });

  it('closing the dialog because verification succeeded does not cancel', () => {
    const s = fakeSession({});
    render(<TransferView session={s} direction="receive" />);
    act(() => s.set({ state: 'verified' }));
    expect(screen.queryByRole('dialog', { name: 'Verification required' })).toBeNull();
    expect(s.cancel).not.toHaveBeenCalled();
    expect(s.mismatch).not.toHaveBeenCalled();
  });

  it('closing the dialog while still verifying (Escape) cancels', () => {
    const s = fakeSession({});
    render(<TransferView session={s} direction="receive" />);
    act(() => screen.getByRole('dialog').dispatchEvent(new Event('close')));
    expect(s.cancel).toHaveBeenCalledOnce();
  });

  it('shows no phrase and no match control before the phrase exists', () => {
    render(<TransferView session={fakeSession({ phrase: null })} direction="receive" />);
    expect(screen.queryByRole('button', { name: 'The words match' })).toBeNull();
  });
});

describe('TransferView: consent', () => {
  const manifest = {
    files: [
      { name: '<img src=x onerror=alert(1)>', size: 1536 },
      { name: 'notes.txt', size: 0 },
    ],
    total: 1536,
  };

  it('lists incoming files as text and offers Accept and Reject', () => {
    const s = fakeSession({ state: 'offered', manifest });
    render(<TransferView session={s} direction="receive" />);
    const dialog = screen.getByRole('dialog', { name: 'Incoming files' });
    expect(within(dialog).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept files' }));
    expect(s.accept).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject files' }));
    expect(s.reject).toHaveBeenCalledOnce();
  });

  it('closing the file dialog after acceptance does not reject', () => {
    const s = fakeSession({ state: 'offered', manifest });
    render(<TransferView session={s} direction="receive" />);
    act(() => s.set({ state: 'transferring', progress: { confirmed: 0, total: 1536 } }));
    expect(s.reject).not.toHaveBeenCalled();
  });

  it('does not show the file dialog to the sender', () => {
    render(<TransferView session={fakeSession({ state: 'offered' })} direction="send" />);
    expect(screen.queryByRole('dialog', { name: 'Incoming files' })).toBeNull();
    expect(screen.getByText(/Waiting for the other person to accept/)).toBeTruthy();
  });

  it('explains an automatic over-limit rejection', () => {
    render(
      <TransferView
        session={fakeSession({ state: 'rejected', tooLarge: true, manifest })}
        direction="receive"
      />,
    );
    expect(screen.getByText(/larger than this browser can receive/)).toBeTruthy();
  });
});

describe('TransferView: transfer and result', () => {
  it('shows confirmed progress and a cancel control', () => {
    const s = fakeSession({ state: 'transferring', progress: { confirmed: 512, total: 2048 } });
    render(<TransferView session={s} direction="send" />);
    const bar = screen.getByRole('progressbar', { name: 'Transfer progress' });
    expect(bar.getAttribute('value')).toBe('512');
    expect(bar.getAttribute('max')).toBe('2048');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }));
    expect(s.cancel).toHaveBeenCalledOnce();
  });

  it('offers verified files as inert downloads', () => {
    const blob = new Blob(['x']);
    const s = fakeSession({
      state: 'completed',
      downloads: [{ name: 'report.pdf', size: 1, url: 'blob:test/1', blob }],
    });
    render(<TransferView session={s} direction="receive" />);
    const link = screen.getByRole('link', { name: /report\.pdf/ });
    expect(link.getAttribute('href')).toBe('blob:test/1');
    expect(link.getAttribute('download')).toBe('report.pdf');
  });

  it.each([
    ['mismatch', /did not match/],
    ['commitment', /could not be completed safely/],
    ['integrity', /integrity check/],
    ['closed', /connection was lost/],
  ] as const)('explains a %s failure', (reason, text) => {
    render(<TransferView session={fakeSession({ state: 'failed', reason })} direction="receive" />);
    expect(screen.getByText(text)).toBeTruthy();
  });
});
