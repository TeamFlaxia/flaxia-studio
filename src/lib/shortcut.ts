export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function modLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

export function modKey(event: KeyboardEvent): boolean {
  return isApplePlatform() ? event.metaKey : event.ctrlKey;
}

export function modShortcut(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

export function formatShortcut(keys: string): string {
  if (!isApplePlatform()) return keys.replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+');
  return keys;
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts.at(-1) ?? '';
  const wantsMod = parts.includes('mod');
  const wantsShift = parts.includes('shift');
  const wantsAlt = parts.includes('alt');
  if (wantsMod !== modKey(event)) return false;
  if (wantsShift !== event.shiftKey) return false;
  if (wantsAlt !== event.altKey) return false;
  return event.key.toLowerCase() === key;
}
