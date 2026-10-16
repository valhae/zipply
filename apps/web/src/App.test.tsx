import { PROTOCOL_VERSION } from '@zipply/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { PeerList } from './features/radar/PeerList';
import { RadarView } from './features/radar/RadarView';
import { readDemo } from './features/radar/fixtures';

beforeEach(() => {
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
});
afterEach(cleanup);

describe('App', () => {
  it('renders the Zipply heading inside the main landmark', () => {
    render(<App />);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 1, name: 'zipply' })).toBeTruthy();
  });

  it('shows the shared protocol version', () => {
    render(<App />);
    expect(screen.getByText(`protocol v${PROTOCOL_VERSION}`)).toBeTruthy();
  });

  it('is truthfully offline with no peers when no discovery exists', () => {
    render(<App />);
    expect(screen.getAllByRole('status').some((s) => s.textContent?.includes('Offline'))).toBe(
      true,
    );
    expect(screen.getByText('No one is discoverable here right now.')).toBeTruthy();
    expect(screen.queryAllByTestId('radar-marker')).toHaveLength(0);
  });

  it('does not show a scanning sweep while offline', () => {
    render(<App />);
    expect(screen.queryByTestId('radar-sweep')).toBeNull();
  });

  it('starts hidden and toggles discoverability with an announcement', () => {
    render(<App />);
    const toggle = screen.getByRole('switch', { name: 'Discoverable' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('You are now discoverable.')).toBeTruthy();
  });
});

describe('untrusted peer names', () => {
  it('render as literal text, never as HTML', () => {
    const { peers } = readDemo('?demo=tricky')!;
    const { container } = render(
      <>
        <PeerList peers={peers} selectedId={null} onSelect={() => {}} />
        <RadarView peers={peers} selectedId={null} />
      </>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText('<img src=x onerror=alert(1)>').length).toBeGreaterThan(0);
  });
});

describe('radar and list parity', () => {
  it('show the same peers', () => {
    const { peers } = readDemo('?demo=few')!;
    render(
      <>
        <PeerList peers={peers} selectedId={null} onSelect={() => {}} />
        <RadarView peers={peers} selectedId={null} />
      </>,
    );
    const listIds = peers.map((p) => p.id);
    const radarIds = screen.getAllByTestId('radar-marker').map((m) => m.dataset.peerId);
    expect(radarIds).toEqual(listIds);
    expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(peers.length);
  });
});
