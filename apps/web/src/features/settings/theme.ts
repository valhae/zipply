import { useEffect, useState } from 'react';

// Keep in sync with the inline no-flash script in index.html.
export const THEME_KEY = 'zipply-theme';
export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function readThemeChoice(storage: StorageLike): ThemeChoice {
  try {
    const value = storage.getItem(THEME_KEY);
    return CHOICES.find((c) => c === value) ?? 'system';
  } catch {
    return 'system';
  }
}

export function saveThemeChoice(storage: StorageLike, choice: ThemeChoice): void {
  try {
    storage.setItem(THEME_KEY, choice);
  } catch {
    // Storage blocked (private mode etc.): the choice lasts for this page only.
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  return choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;
}

export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

function safeLocalStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const storage = safeLocalStorage();
    return storage ? readThemeChoice(storage) : 'system';
  });

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const apply = () => applyTheme(document.documentElement, resolveTheme(choice, media.matches));
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);

  const choose = (next: ThemeChoice) => {
    const storage = safeLocalStorage();
    if (storage) saveThemeChoice(storage, next);
    setChoice(next);
  };

  return [choice, choose] as const;
}
