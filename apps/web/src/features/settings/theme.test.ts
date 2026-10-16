import { describe, expect, it } from 'vitest';
import { THEME_KEY, applyTheme, readThemeChoice, resolveTheme, saveThemeChoice } from './theme';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
};

const throwingStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('readThemeChoice', () => {
  it.each(['light', 'dark', 'system'] as const)('returns a stored %s choice', (choice) => {
    expect(readThemeChoice(memoryStorage({ [THEME_KEY]: choice }))).toBe(choice);
  });

  it('defaults to system when nothing is stored', () => {
    expect(readThemeChoice(memoryStorage())).toBe('system');
  });

  it('defaults to system for an invalid stored value', () => {
    expect(readThemeChoice(memoryStorage({ [THEME_KEY]: '<script>' }))).toBe('system');
  });

  it('defaults to system when storage throws', () => {
    expect(readThemeChoice(throwingStorage)).toBe('system');
  });
});

describe('saveThemeChoice', () => {
  it('persists the choice', () => {
    const storage = memoryStorage();
    saveThemeChoice(storage, 'dark');
    expect(storage.data[THEME_KEY]).toBe('dark');
  });

  it('does not throw when storage is unavailable', () => {
    expect(() => saveThemeChoice(throwingStorage, 'dark')).not.toThrow();
  });
});

describe('resolveTheme', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as const)('%s with prefersDark=%s resolves to %s', (choice, prefersDark, expected) => {
    expect(resolveTheme(choice, prefersDark)).toBe(expected);
  });
});

describe('applyTheme', () => {
  it('sets the dark class and color-scheme, then removes them for light', () => {
    const root = document.createElement('html');
    applyTheme(root, 'dark');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    applyTheme(root, 'light');
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
  });
});
