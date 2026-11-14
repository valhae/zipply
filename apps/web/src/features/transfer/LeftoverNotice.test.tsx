import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeftoverNotice } from './LeftoverNotice';

afterEach(cleanup);

describe('LeftoverNotice (P6-06, D22)', () => {
  it('reports partial data from an earlier visit and deletes it on request', async () => {
    const remove = vi.fn(async () => {});
    render(<LeftoverNotice find={async () => ({ bytes: 3 * 1024 * 1024, remove })} />);
    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/3\.0 MiB/);
    expect(note.textContent).toMatch(/cannot be resumed/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete it' })));
    expect(remove).toHaveBeenCalledOnce();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows nothing when there is none, or when browser storage is unavailable', async () => {
    render(
      <>
        <LeftoverNotice find={async () => ({ bytes: 0, remove: async () => {} })} />
        <LeftoverNotice find={() => Promise.reject(new Error('no OPFS'))} />
      </>,
    );
    await act(async () => {});
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('keeps the first result when the effect runs twice (StrictMode, or a second tab)', async () => {
    // The second scan finds the folder locked by the first one and reports nothing.
    const results = [3 * 1024 * 1024, 0];
    const find = vi.fn(async () => ({ bytes: results.shift()!, remove: async () => {} }));
    render(
      <StrictMode>
        <LeftoverNotice find={find} />
      </StrictMode>,
    );
    expect((await screen.findByRole('note')).textContent).toMatch(/3\.0 MiB/);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
