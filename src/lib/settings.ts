export interface Settings {
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  autoSave: boolean;
  minimap: boolean;
  linuxNetwork: boolean;
  linuxManifestUrl: string;
}

const SETTINGS_KEY = 'flaxia_studio_settings';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 13,
  tabSize: 2,
  wordWrap: false,
  autoSave: true,
  minimap: true,
  linuxNetwork: true,
  linuxManifestUrl: 'auto',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      fontSize: clamp(parsed.fontSize ?? DEFAULT_SETTINGS.fontSize, 10, 28),
      tabSize: clamp(parsed.tabSize ?? DEFAULT_SETTINGS.tabSize, 1, 8),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings are best-effort.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
