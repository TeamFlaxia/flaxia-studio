import { el } from '../lib/dom';
import { type IconName, icon } from '../lib/icons';
import { closeWithAnimation } from '../lib/motion';

export interface PaletteItem {
  id: string;
  label: string;
  group?: string;
  hint?: string;
  keywords?: string;
  icon?: IconName;
  run: () => void;
}

export interface PaletteOptions {
  placeholder?: string;
  emptyText?: string;
  prefix?: IconName;
  footer?: string;
  onClose?: () => void;
}

let activeClose: (() => void) | null = null;

export function isPaletteOpen(): boolean {
  return activeClose !== null;
}

export function openPalette(items: PaletteItem[], options: PaletteOptions = {}): void {
  activeClose?.();
  const root = document.getElementById('modal-root');
  if (!root) return;

  const previouslyFocused = document.activeElement as HTMLElement | null;
  let filtered = items;
  let selected = 0;

  const overlay = el('div', { class: 'overlay cmd-overlay' });
  const dialog = el('div', { class: 'dialog cmd-dialog', role: 'dialog', attrs: { 'aria-modal': 'true' } });
  dialog.setAttribute('aria-label', options.placeholder ?? 'Command palette');

  const input = el('input', {
    class: 'cmd-input',
    type: 'text',
    attrs: {
      placeholder: options.placeholder ?? 'Type a command…',
      autocomplete: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'cmd-listbox',
      'aria-autocomplete': 'list',
    },
  });
  input.id = 'cmd-input';

  const list = el('div', { class: 'cmd-list', id: 'cmd-listbox', role: 'listbox' });

  const head = el('div', { class: 'cmd-input-row' }, [
    icon(options.prefix ?? 'command', 16),
    input,
    el('span', { class: 'kbd', text: 'Esc' }),
  ]);

  const foot = el('div', { class: 'cmd-foot' }, [
    el('span', {}, [el('span', { class: 'kbd', text: '↑↓' }), ' Navigate']),
    el('span', {}, [el('span', { class: 'kbd', text: '↵' }), ' Select']),
    options.footer ? el('span', { text: options.footer }) : null,
  ]);

  dialog.append(head, list, foot);
  overlay.appendChild(dialog);
  root.appendChild(overlay);

  function close(): void {
    if (activeClose !== close) return;
    activeClose = null;
    closeWithAnimation(overlay, () => {
      options.onClose?.();
      previouslyFocused?.focus?.();
    });
  }

  function matches(item: PaletteItem, query: string): boolean {
    if (!query) return true;
    const haystack = `${item.label} ${item.group ?? ''} ${item.keywords ?? ''}`.toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((part) => haystack.includes(part));
  }

  function render(): void {
    const query = input.value.trim();
    filtered = items.filter((item) => matches(item, query));
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
    list.replaceChildren();

    if (filtered.length === 0) {
      list.appendChild(el('div', { class: 'cmd-empty', text: options.emptyText ?? 'No matching items.' }));
      updateActiveDescendant();
      return;
    }

    let group = '';
    filtered.forEach((item, index) => {
      if (item.group && item.group !== group) {
        group = item.group;
        list.appendChild(el('div', { class: 'cmd-group', text: group }));
      }
      const row = el(
        'button',
        {
          class: `cmd-item ${index === selected ? 'is-selected' : ''}`.trim(),
          type: 'button',
          id: `cmd-item-${index}`,
          role: 'option',
          attrs: { 'aria-selected': String(index === selected), tabindex: '-1' },
          on: {
            mouseenter: () => {
              selected = index;
              renderSelection();
            },
            click: () => run(index),
          },
        },
        [
          el('span', { class: 'cmd-item-icon' }, [icon(item.icon ?? 'circle', 15)]),
          el('span', { class: 'cmd-item-label', text: item.label }),
          item.hint ? el('span', { class: 'kbd cmd-item-hint', text: item.hint }) : null,
        ],
      );
      list.appendChild(row);
    });
    updateActiveDescendant();
  }

  function renderSelection(): void {
    list.querySelectorAll<HTMLElement>('.cmd-item').forEach((row, index) => {
      const isSelected = index === selected;
      row.classList.toggle('is-selected', isSelected);
      row.setAttribute('aria-selected', String(isSelected));
    });
    updateActiveDescendant();
    const current = list.querySelector<HTMLElement>('.cmd-item.is-selected');
    current?.scrollIntoView({ block: 'nearest' });
  }

  function updateActiveDescendant(): void {
    if (filtered.length === 0) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', `cmd-item-${selected}`);
  }

  function run(index: number): void {
    const item = filtered[index];
    if (!item) return;
    close();
    window.setTimeout(() => item.run(), 0);
  }

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = Math.min(filtered.length - 1, selected + 1);
      renderSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(0, selected - 1);
      renderSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(selected);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  });

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });

  activeClose = close;
  render();
  window.setTimeout(() => input.focus(), 20);
}
