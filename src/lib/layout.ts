/**
 * Pane sizes that the user dragged by hand.
 *
 * The explorer sidebar writes its width into the CSS variable `--sidebar-w`;
 * the value is kept in localStorage so a reload restores the same layout.
 */

export interface LayoutSizes {
  sidebarWidth: number | null;
}

const LAYOUT_KEY = 'flaxia_studio_layout';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 520;

export const EMPTY_LAYOUT: LayoutSizes = { sidebarWidth: null };

/** Clamps the explorer width to a usable range for the current viewport. */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const viewportMax = Math.max(SIDEBAR_MIN, Math.round(viewportWidth * 0.45));
  const max = Math.min(SIDEBAR_MAX, viewportMax);
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)));
}

export function loadLayoutSizes(): LayoutSizes {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...EMPTY_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<LayoutSizes>;
    return { sidebarWidth: toSize(parsed.sidebarWidth) };
  } catch {
    return { ...EMPTY_LAYOUT };
  }
}

export function saveLayoutSizes(sizes: LayoutSizes): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes));
  } catch {
    // Layout persistence is best-effort.
  }
}

/** Writes the stored sizes into the CSS variables the panes read. */
export function applyLayoutSizes(sizes: LayoutSizes): void {
  if (sizes.sidebarWidth) {
    document.documentElement.style.setProperty('--sidebar-w', `${sizes.sidebarWidth}px`);
  }
}

function toSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}
