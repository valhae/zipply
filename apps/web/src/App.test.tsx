import { PROTOCOL_VERSION } from '@zipply/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';

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
});
