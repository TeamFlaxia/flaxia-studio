import { el } from '../lib/dom';
import { type IconName, icon } from '../lib/icons';

export interface ContextMenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  document.querySelector('.context-menu')?.remove();

  const menu = el('div', { class: 'context-menu', role: 'menu' });
  for (const item of items) {
    const row = el(
      'button',
      {
        class: `context-item ${item.danger ? 'is-danger' : ''}`.trim(),
        type: 'button',
        role: 'menuitem',
        attrs: { disabled: item.disabled ?? false },
        on: {
          click: () => {
            close();
            item.run();
          },
        },
      },
      [
        el('span', { class: 'context-icon' }, [icon(item.icon ?? 'circle', 14)]),
        el('span', { class: 'context-label', text: item.label }),
      ],
    );
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

  const close = () => {
    menu.remove();
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', close);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  window.setTimeout(() => {
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', close);
  }, 0);
}
