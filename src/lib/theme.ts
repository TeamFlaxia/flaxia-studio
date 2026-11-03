export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'flaxia_theme';
const LIGHT_COLOR = '#ffffff';
const DARK_COLOR = '#181d28';

let mediaListenerAttached = false;

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage can be unavailable in private contexts.
  }
  return 'system';
}

export function getResolvedTheme(): 'light' | 'dark' {
  const theme = getTheme();
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark() ? 'dark' : 'light';
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function updateThemeColor(resolved: 'light' | 'dark'): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? DARK_COLOR : LIGHT_COLOR);
}

export function applyTheme(): 'light' | 'dark' {
  const resolved = getResolvedTheme();
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  updateThemeColor(resolved);
  return resolved;
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Ignore storage failures; the visual theme still applies.
  }
  applyTheme();
  window.dispatchEvent(new CustomEvent('flaxia:theme', { detail: { theme } }));
}

export function cycleTheme(): Theme {
  const current = getTheme();
  const next: Theme = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
  setTheme(next);
  return next;
}

export function initTheme(): void {
  applyTheme();

  if (!mediaListenerAttached && typeof window !== 'undefined' && window.matchMedia) {
    mediaListenerAttached = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getTheme() === 'system') {
        applyTheme();
        window.dispatchEvent(new CustomEvent('flaxia:theme', { detail: { theme: 'system' } }));
      }
    });
  }
}

export function themeLabel(theme: Theme): string {
  return theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System';
}
