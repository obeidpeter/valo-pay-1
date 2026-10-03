import { browserStorageKey } from '@/lib/browser-identity';
import { useSyncExternalStore } from 'react';

/**
 * Light or dark. The console follows the device unless a person chooses
 * otherwise on the settings page, and the choice is kept in this browser only:
 * it belongs to the person and the screen, not to the workspace, so it works
 * without an account and before any request, and two people sharing a
 * workspace never fight over it. `index.html` applies the same rule inline
 * before the first paint, so a dark device never sees a white flash; that
 * script and this module share the key and the rule, and a test pins them
 * together.
 */
export const THEME_STORAGE_KEY = browserStorageKey('theme');
/** What the person chose: follow the device, or one theme. */
export type ThemeChoice = 'system' | 'light' | 'dark';
/** A theme as shown. */
export type Theme = 'light' | 'dark';
/** The choice and the theme it resolves to right now. */
export type ThemeState = { choice: ThemeChoice; theme: Theme };

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The choices as the settings page offers them, with their labels. */
export const themeChoices: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'Follow the device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The rule, the same as the inline script's: a choice wins, otherwise the device decides. */
export function resolveTheme(choice: ThemeChoice, deviceDark: boolean): Theme {
  return choice === 'dark' || (choice === 'system' && deviceDark) ? 'dark' : 'light';
}

// When storage is blocked (a private window, cleared site data) a choice still lasts for this page.
let memoryChoice: ThemeChoice = 'system';

/** The stored choice, or the in-memory one when storage is blocked; "system" when nothing is stored. */
export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return memoryChoice;
  }
}

let media: MediaQueryList | null = null;
let state: ThemeState = { choice: 'system', theme: 'light' };
const listeners = new Set<() => void>();

function deviceDark(): boolean {
  if (media) return media.matches;
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

function apply(): void {
  const choice = readChoice();
  const theme = resolveTheme(choice, deviceDark());
  document.documentElement.classList.toggle('dark', theme === 'dark');
  if (choice !== state.choice || theme !== state.theme) {
    state = { choice, theme };
    listeners.forEach((listener) => listener());
  }
}

/** Applies the theme now and keeps it applied as the device or another tab changes it. Safe to call more than once. */
export function initTheme(): void {
  if (!media && typeof window.matchMedia === 'function') {
    media = window.matchMedia(DARK_QUERY);
    media.addEventListener('change', apply);
    window.addEventListener('storage', (event) => { if (event.key === null || event.key === THEME_STORAGE_KEY) apply(); });
  }
  apply();
}

/** Stores the choice where storage allows and applies it at once. */
export function setThemeChoice(choice: ThemeChoice): void {
  memoryChoice = choice;
  try {
    if (choice === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage blocked: the choice lasts for this page, from memoryChoice.
  }
  apply();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  initTheme();
  return () => { listeners.delete(listener); };
}

const getState = () => state;

/** The theme showing, the choice behind it, and the way to change the choice. */
export function useTheme(): ThemeState & { setChoice: (choice: ThemeChoice) => void } {
  const current = useSyncExternalStore(subscribe, getState, getState);
  return { ...current, setChoice: setThemeChoice };
}
