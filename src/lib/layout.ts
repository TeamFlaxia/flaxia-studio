/**
 * Pane sizes that the user dragged by hand.
 *
 * The explorer sidebar writes its width into the CSS variable `--sidebar-w` and
 * the inspector writes its width into `--inspector-w`; the values are kept in
 * localStorage so a reload restores the same layout.
 */

export interface LayoutSizes {
  sidebarWidth: number | null;
  inspectorWidth: number | null;
  /** `null` means "use the viewport default". */
  inspectorVisible: boolean | null;
}

const LAYOUT_KEY = 'flaxia_studio_layout';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 520;

export const INSPECTOR_MIN = 240;
export const INSPECTOR_MAX = 420;

export const EMPTY_LAYOUT: LayoutSizes = {
  sidebarWidth: null,
  inspectorWidth: null,
  inspectorVisible: null,
};

/** Clamps the explorer width to a usable range for the current viewport. */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const viewportMax = Math.max(SIDEBAR_MIN, Math.round(viewportWidth * 0.45));
  const max = Math.min(SIDEBAR_MAX, viewportMax);
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)));
}

/** Clamps the right-hand inspector width to a usable range. */
export function clampInspectorWidth(width: number, viewportWidth: number): number {
  const viewportMax = Math.max(INSPECTOR_MIN, Math.round(viewportWidth * 0.4));
  const max = Math.min(INSPECTOR_MAX, viewportMax);
  return Math.min(max, Math.max(INSPECTOR_MIN, Math.round(width)));
}

export function loadLayoutSizes(): LayoutSizes {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...EMPTY_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<LayoutSizes>;
    return {
      sidebarWidth: toSize(parsed.sidebarWidth),
      inspectorWidth: toSize(parsed.inspectorWidth),
      inspectorVisible: toBoolean(parsed.inspectorVisible),
    };
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
  if (sizes.inspectorWidth) {
    document.documentElement.style.setProperty('--inspector-w', `${sizes.inspectorWidth}px`);
  }
}

function toSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function toBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
