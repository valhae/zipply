import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session, Snapshot } from '../connection/session';
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

const SAY = ['apple', 'banana', 'cherry'];
const base: Snapshot = {
  state: 'verifying',
  say: SAY,
  attemptsLeft: 3,
  localConfirmed: false,
  resuming: false,
  manifest: null,
  plan: null,
  progress: null,
  expiresAt: null,
  downloads: [],
};
const progress = (confirmed: number, total: number, over = {}) => ({
  confirmed,
  total,
  speed: null,
  average: null,
  eta: null,
  ...over,
});

function fakeSession(patch: Partial<Snapshot>, role: 'offerer' | 'answerer' = 'answerer') {
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
    checkWords: vi.fn<(typed: string) => 'ok' | 'wrong' | 'failed' | 'ignored'>(),
    mismatch: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    lost: vi.fn(),
    dispose: vi.fn(),
    role,
    attach: vi.fn(() => true),
    debug: vi.fn(() => ({
      role,
      state: snap.state,
      chunkSize: 65_536,
      maxMessageSize: 262_144,
      high: 1_048_576,
      low: 262_144,
      ackEvery: 1_048_576,
      bufferedAmount: 4096,
      queued: 10_000,
      confirmed: 8192,
      total: 20_000,
      stats: async () => ({ ice: 'connected', route: 'host → host (udp)' }),
    })),
  } satisfies Session & { set: (next: Partial<Snapshot>) => void };
}

describe('TransferView: verification', () => {
  it('shows only the three words to read aloud, a field for the heard words, and no skip path', () => {
    const s = fakeSession({});
    render(<TransferView session={s} direction="receive" />);
    const dialog = screen.getByRole('dialog', { name: 'Verification required' });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(SAY);
    // Required: an empty submit is stopped by the browser and never uses up a try.
    expect(within(dialog).getByRole('textbox', { name: 'Words you hear' })).toHaveProperty(
      'required',
      true,
    );
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual(['Check words', 'Mismatch — cancel']);
    expect(screen.queryByRole('button', { name: /skip|continue|trust|match$/i })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mismatch — cancel' }));
    expect(s.mismatch).toHaveBeenCalledOnce();
  });

  it('checks exactly what the user typed, on submit (button or Enter)', () => {
    const s = fakeSession({});
    render(<TransferView session={s} direction="receive" />);
    const field = screen.getByRole('textbox', { name: 'Words you hear' });
    fireEvent.change(field, { target: { value: 'delta echo fox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check words' }));
    fireEvent.submit(field.closest('form')!);
    expect(s.checkWords.mock.calls).toEqual([['delta echo fox'], ['delta echo fox']]);
  });

  it('says how many tries are left after a wrong entry', () => {
    render(<TransferView session={fakeSession({ attemptsLeft: 2 })} direction="send" />);
    expect(screen.getByRole('alert').textContent).toMatch(/do not match.*2 tries left/);
  });

  it('waits for the other person after a local confirmation', () => {
    render(<TransferView session={fakeSession({ localConfirmed: true })} direction="send" />);
    expect(screen.queryByRole('textbox', { name: 'Words you hear' })).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Verification required' });
    expect(
      within(dialog).getByText(/Waiting for the other person to check your words/),
    ).toBeTruthy();
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

  it('shows no words and no check control before the phrase exists', () => {
    render(<TransferView session={fakeSession({ say: null })} direction="receive" />);
    expect(screen.queryByRole('button', { name: 'Check words' })).toBeNull();
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
    act(() => s.set({ state: 'transferring', progress: progress(0, 1536) }));
    expect(s.reject).not.toHaveBeenCalled();
  });

  it('does not show the file dialog to the sender', () => {
    render(<TransferView session={fakeSession({ state: 'offered' })} direction="send" />);
    expect(screen.queryByRole('dialog', { name: 'Incoming files' })).toBeNull();
    expect(screen.getByText(/Waiting for the other person to accept/)).toBeTruthy();
  });

  it.each([
    [{ kind: null, reason: 'no-sink' }, /no way to save files this large/],
    [{ kind: null, reason: 'no-space', free: 1024 }, /not enough free storage.*1\.0 KiB/],
  ] as const)('explains an automatic rejection: %j', (plan, text) => {
    render(
      <TransferView
        session={fakeSession({ state: 'rejected', plan, manifest })}
        direction="receive"
      />,
    );
    expect(screen.getByText(text)).toBeTruthy();
  });

  // P6-01: suitability is shown before Accept.
  it.each([
    [{ kind: 'memory' }, /saved to your downloads/i],
    [{ kind: 'folder' }, /choose a folder/i],
    [{ kind: 'browser', free: 5 * 1024 ** 3 }, /browser's storage.*5\.0 GiB free/],
  ] as const)('says where the files will go before Accept: %j', (plan, text) => {
    render(
      <TransferView
        session={fakeSession({ state: 'offered', manifest, plan })}
        direction="receive"
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Incoming files' });
    expect(within(dialog).getByText(text)).toBeTruthy();
  });
});

describe('TransferView: transfer and result', () => {
  it('shows confirmed progress and a cancel control', () => {
    const s = fakeSession({ state: 'transferring', progress: progress(512, 2048) });
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

describe('TransferView: queue states (P6-09)', () => {
  it('shows speed, the rolling average and an ETA only when one is given', () => {
    const s = fakeSession({ state: 'transferring', progress: progress(512, 2048) });
    render(<TransferView session={s} direction="receive" />);
    expect(screen.queryByText(/left/)).toBeNull();
    act(() => s.set({ progress: progress(1024, 2048, { speed: 2048, average: 1024, eta: 90 }) }));
    expect(
      screen.getByText(/2\.0 KiB\/s now · 1\.0 KiB\/s average · about 2 min left/),
    ).toBeTruthy();
  });

  it('progress updates never change the announced status line', () => {
    const s = fakeSession({ state: 'transferring', progress: progress(0, 2048) });
    render(<TransferView session={s} direction="receive" />);
    const status = screen.getByRole('status');
    const before = status.textContent;
    act(() => s.set({ progress: progress(1500, 2048, { speed: 10, average: 10, eta: 50 }) }));
    expect(status.textContent).toBe(before);
    expect(within(status).queryByText(/KiB/)).toBeNull();
  });

  it('a paused sender can reconnect or cancel; the confirmed checkpoint is shown', () => {
    const onReconnect = vi.fn();
    const s = fakeSession(
      { state: 'paused', progress: progress(1024, 4096), expiresAt: Date.now() + 600_000 },
      'offerer',
    );
    render(<TransferView session={s} direction="send" peerName="Alex" onReconnect={onReconnect} />);
    expect(screen.getByRole('status').textContent).toMatch(/Paused/);
    expect(screen.getByText(/1\.0 KiB of 4\.0 KiB confirmed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onReconnect).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }));
    expect(s.cancel).toHaveBeenCalledOnce();
  });

  it('a paused receiver waits for the sender and has no Reconnect button', () => {
    const s = fakeSession({ state: 'paused', progress: progress(1, 4) });
    render(<TransferView session={s} direction="receive" peerName="Alex" />);
    expect(screen.getByRole('status').textContent).toMatch(/Waiting for Alex to reconnect/);
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('a new connection for a paused transfer asks for the words again and says why', () => {
    render(<TransferView session={fakeSession({ resuming: true })} direction="receive" />);
    const dialog = screen.getByRole('dialog', { name: 'Verification required' });
    expect(within(dialog).getByText(/new connection.*paused transfer/i)).toBeTruthy();
  });

  it.each([
    ['storage', /could not be saved/],
    ['expired', /could not be resumed/],
  ] as const)('explains a %s failure', (reason, text) => {
    render(<TransferView session={fakeSession({ state: 'failed', reason })} direction="receive" />);
    expect(screen.getByText(text)).toBeTruthy();
  });
});

describe('TransferView: debug panel (P6-07)', () => {
  it('is closed until opened and shows only sizes, counters and the route type', async () => {
    const manifest = { files: [{ name: 'a.txt', size: 1 }], total: 1 };
    const s = fakeSession({ state: 'transferring', progress: progress(1, 2), manifest });
    render(<TransferView session={s} direction="receive" />);
    const panel = screen.getByText('Connection details').closest('details')!;
    expect(panel.open).toBe(false);
    await act(async () => {
      panel.open = true;
      panel.dispatchEvent(new Event('toggle'));
    });
    expect(panel.textContent).toMatch(/64\.0 KiB/);
    expect(panel.textContent).toMatch(/host → host \(udp\)/);
    expect(panel.textContent).not.toMatch(/a\.txt|b\.bin/);
  });
});

describe('TransferView: automatic save', () => {
  const blob = new Blob(['x']);
  const downloads = [
    { name: 'a.pdf', size: 1, url: 'blob:test/a', blob },
    { name: 'b.txt', size: 1, url: 'blob:test/b', blob },
  ];
  const clicks = () => {
    const seen: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      seen.push({ href: this.getAttribute('href')!, download: this.download });
    });
    return seen;
  };
  afterEach(() => vi.restoreAllMocks());

  it('saves every verified file once the transfer completes (receiver only)', () => {
    const seen = clicks();
    const s = fakeSession({ state: 'transferring', progress: progress(1, 2) });
    const { rerender } = render(<TransferView session={s} direction="receive" />);
    expect(seen).toEqual([]);
    act(() => s.set({ state: 'completed', downloads }));
    expect(seen).toEqual([
      { href: 'blob:test/a', download: 'a.pdf' },
      { href: 'blob:test/b', download: 'b.txt' },
    ]);
    rerender(<TransferView session={s} direction="receive" />);
    expect(seen).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Save a\.pdf/ })).toBeTruthy(); // fallback stays
  });

  it('files written into a chosen folder are listed, not downloaded again', () => {
    const seen = clicks();
    const s = fakeSession({
      state: 'completed',
      downloads: [{ name: 'big.iso', size: 1, url: null, blob }],
    });
    render(<TransferView session={s} direction="receive" />);
    expect(seen).toEqual([]);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Saved big\.iso/)).toBeTruthy();
  });

  it('never saves on the sending side', () => {
    const seen = clicks();
    render(
      <TransferView session={fakeSession({ state: 'completed', downloads })} direction="send" />,
    );
    expect(seen).toEqual([]);
  });
});
