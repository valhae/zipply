import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../connection/session';
import { IDLE_PAIRING, type Pairing, type PairingSnapshot } from './pairing';
import { PairingPanel } from './PairingPanel';

// The camera and QR libraries are not part of these tests; the scanner hands back one code.
vi.mock('./Scanner', () => ({
  Scanner: ({ onCode }: { onCode: (code: string) => void }) => (
    <button type="button" onClick={() => onCode('zipply1.SCANNED')}>
      fake scan
    </button>
  ),
}));
vi.mock('./Qr', () => ({ Qr: ({ label }: { label: string }) => <p>{label}</p> }));

function store(over: Partial<PairingSnapshot> = {}) {
  let snap: PairingSnapshot = { ...IDLE_PAIRING, ...over };
  const listeners = new Set<() => void>();
  const p = {
    getSnapshot: () => snap,
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    send: vi.fn(),
    receive: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    set(next: Partial<PairingSnapshot>) {
      snap = { ...snap, ...next };
      act(() => listeners.forEach((fn) => fn()));
    },
  };
  return p as typeof p & Pairing;
}
const session = (state: string, role = 'answerer') =>
  ({
    role,
    getSnapshot: () => ({ state, say: null, manifest: null, progress: null, files: [] }),
    subscribe: () => () => {},
  }) as unknown as Session;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PairingPanel (P7-03, P7-05)', () => {
  it('explains the limits honestly and never claims to scan the network', () => {
    render(<PairingPanel pairing={store()} busy={false} />);
    const text = document.body.textContent!;
    expect(text).toMatch(/same Wi-Fi/i);
    expect(text).toMatch(/VPN/);
    expect(text).toMatch(/isolat/i);
    expect(text).toMatch(/does not search|does not scan/i);
    expect(text).not.toMatch(/nearby|scanning for|searching for devices/i);
  });

  it('send needs chosen files; then the sender creates a code', () => {
    const p = store();
    render(<PairingPanel pairing={p} busy={false} />);
    const create = screen.getByRole('button', { name: 'Create pairing code' });
    expect(create).toHaveProperty('disabled', true);
    const file = new File(['x'], 'a.txt');
    fireEvent.change(screen.getByLabelText('Files to send'), { target: { files: [file] } });
    fireEvent.click(create);
    expect(p.send).toHaveBeenCalledWith([file]);
  });

  it('the receiver pastes the sender code and creates an answer', () => {
    const p = store();
    render(<PairingPanel pairing={p} busy={false} />);
    fireEvent.change(screen.getByLabelText('Code from the sending device'), {
      target: { value: 'zipply1.ABC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create answer' }));
    expect(p.receive).toHaveBeenCalledWith('zipply1.ABC');
  });

  it('a scanned QR only fills the field: nothing is accepted or created by scanning', () => {
    const p = store();
    render(<PairingPanel pairing={p} busy={false} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Scan QR code' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'fake scan' }));
    expect(screen.getByLabelText('Code from the sending device')).toHaveProperty(
      'value',
      'zipply1.SCANNED',
    );
    expect(p.receive).not.toHaveBeenCalled();
    expect(p.send).not.toHaveBeenCalled();
  });

  it('the sender shows its code (text and QR) and connects with the answer code', () => {
    const p = store({ phase: 'offer', role: 'offerer', code: 'zipply1.OFFER' });
    render(<PairingPanel pairing={p} busy={false} />);
    expect(screen.getByLabelText('Your pairing code')).toHaveProperty('value', 'zipply1.OFFER');
    expect(screen.getByText('QR code of your pairing code')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Answer code from the receiving device'), {
      target: { value: 'zipply1.ANSWER' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(p.connect).toHaveBeenCalledWith('zipply1.ANSWER');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.cancel).toHaveBeenCalled();
  });

  it.each([
    ['not-zipply', 'That is not a Zipply pairing code.'],
    ['invalid', 'That code is damaged or incomplete. Copy it again.'],
  ] as const)('shows the %s import error as text', (error, message) => {
    render(<PairingPanel pairing={store({ error })} busy={false} />);
    expect(screen.getByRole('alert').textContent).toBe(message);
  });

  it('the receiver keeps showing its answer code while the sender connects', () => {
    const p = store({
      phase: 'session',
      role: 'answerer',
      code: 'zipply1.ANSWER',
      session: session('connecting'),
    });
    render(<PairingPanel pairing={p} busy={false} />);
    expect(screen.getByLabelText('Your answer code')).toHaveProperty('value', 'zipply1.ANSWER');
    expect(screen.getByText(/Waiting for the sending device/)).toBeTruthy();
  });

  it('a failed connection explains the likely causes and can be closed', () => {
    const p = store({ phase: 'ended', notice: 'unavailable' });
    render(<PairingPanel pairing={p} busy={false} />);
    expect(screen.getByRole('status').textContent).toMatch(/could not be set up/);
    expect(document.body.textContent).toMatch(/local network names|mDNS/);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(p.dismiss).toHaveBeenCalled();
  });

  it('is disabled while an online connection is in progress', () => {
    render(<PairingPanel pairing={store()} busy />);
    expect(screen.getByRole('button', { name: 'Create answer' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Files to send')).toHaveProperty('disabled', true);
  });
});
