import { type IconName, icon } from './icons';

type Child = Node | string | number | null | undefined | false;

interface ElOptions {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  id?: string;
  type?: string;
  role?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.title) node.title = options.title;
  if (options.id) node.id = options.id;
  if (options.type) node.setAttribute('type', options.type);
  if (options.role) node.setAttribute('role', options.role);
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler as EventListener);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

export function iconButton(
  name: IconName,
  label: string,
  onClick: (event: MouseEvent) => void,
  options: { size?: number; className?: string; pressed?: boolean } = {},
): HTMLButtonElement {
  const button = el(
    'button',
    {
      class: `icon-button ${options.className ?? ''}`.trim(),
      type: 'button',
      title: label,
      attrs: {
        'aria-label': label,
        ...(options.pressed === undefined ? {} : { 'aria-pressed': String(options.pressed) }),
      },
      on: { click: onClick },
    },
    [icon(name, options.size ?? 16)],
  );
  return button;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
