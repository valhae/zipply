import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NameControl } from './NameControl';

afterEach(cleanup);

const props = {
  name: 'VoxlByte',
  custom: false,
  taken: false,
  busy: false,
  onChange: () => {},
  onRandom: () => {},
};
const edit = () => fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
const field = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Display name' });
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

describe('NameControl', () => {
  it('shows the name in a read-only textbox and saves a new one-word name (trimmed, NFC)', () => {
    const onChange = vi.fn();
    render(<NameControl {...props} onChange={onChange} />);
    expect(field().value).toBe('VoxlByte');
    expect(field().readOnly).toBe(true);
    edit();
    expect(field().readOnly).toBe(false);
    expect(document.activeElement).toBe(field());
    type('  Bücher_laptop  ');
    save();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Bücher_laptop');
    expect(field().readOnly).toBe(true);
  });

  it.each([
    ['empty', '   '],
    ['two words', 'Mar laptop'],
    ['too long', 'x'.repeat(33)],
    ['a hidden direction character', 'photo‮gnp'],
  ])('refuses %s with an explanation', (_, value) => {
    const onChange = vi.fn();
    render(<NameControl {...props} onChange={onChange} />);
    edit();
    type(value);
    save();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/one word/i);
  });

  it('cancel keeps the old name', () => {
    const onChange = vi.fn();
    render(<NameControl {...props} onChange={onChange} />);
    edit();
    type('Other');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(field().value).toBe('VoxlByte');
    expect(field().readOnly).toBe(true);
  });

  it('offers a random name only when the name was chosen by the user', () => {
    const onRandom = vi.fn();
    const { rerender } = render(<NameControl {...props} onRandom={onRandom} />);
    expect(screen.queryByRole('button', { name: 'Random name' })).toBeNull();
    rerender(<NameControl {...props} name="Mar" custom onRandom={onRandom} />);
    fireEvent.click(screen.getByRole('button', { name: 'Random name' }));
    expect(onRandom).toHaveBeenCalledOnce();
  });

  it('says when someone visible here already uses the name', () => {
    render(<NameControl {...props} name="Mar" custom taken />);
    expect(screen.getByRole('alert').textContent).toMatch(/already uses this name/);
  });

  it('cannot be changed during a connection', () => {
    render(<NameControl {...props} name="Mar" custom busy />);
    expect(screen.getByRole('button', { name: 'Edit name' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Random name' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/when no connection is in progress/)).toBeTruthy();
  });
});
