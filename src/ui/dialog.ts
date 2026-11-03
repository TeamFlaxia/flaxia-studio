import { el } from '../lib/dom';
import { icon } from '../lib/icons';
import { closeWithAnimation } from '../lib/motion';

export interface DialogAction {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogOptions {
  title: string;
  body: Node | string;
  actions?: DialogAction[];
  width?: number;
  centered?: boolean;
  onClose?: () => void;
}

export function openDialog(options: DialogOptions): Promise<string> {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolve('');
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const overlay = el('div', { class: `overlay ${options.centered ? 'is-centered' : ''}`.trim() });
    const dialog = el('div', { class: 'dialog', role: 'dialog', attrs: { 'aria-modal': 'true' } });
    if (options.width) dialog.style.width = `min(${options.width}px, 100%)`;
    dialog.setAttribute('aria-label', options.title);

    const head = el('div', { class: 'dialog-head' }, [
      el('div', { class: 'dialog-title', text: options.title }),
      el(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          attrs: { 'aria-label': 'Close' },
          on: { click: () => finish('') },
        },
        [icon('x', 16)],
      ),
    ]);

    const body = el('div', { class: 'dialog-body' });
    if (typeof options.body === 'string') body.textContent = options.body;
    else body.appendChild(options.body);

    const actions = options.actions ?? [{ label: 'Close', value: '' }];
    const foot = el(
      'div',
      { class: 'dialog-foot' },
      actions.map((action) =>
        el(
          'button',
          {
            class: `btn ${action.primary ? 'btn-primary' : ''} ${action.danger ? 'btn-danger' : ''}`.trim(),
            type: 'button',
            text: action.label,
            on: { click: () => finish(action.value) },
          },
          [],
        ),
      ),
    );

    dialog.append(head, body, foot);
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    const finish = (value: string) => {
      closeWithAnimation(overlay, () => {
        options.onClose?.();
        previouslyFocused?.focus?.();
        resolve(value);
      });
    };

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish('');
    });

    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('');
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const first = dialog.querySelector<HTMLElement>('input, select, textarea, .btn-primary, .btn');
    window.setTimeout(() => first?.focus(), 20);
  });
}

export function promptDialog(
  title: string,
  label: string,
  value = '',
  options: { hint?: string; placeholder?: string; confirmLabel?: string } = {},
): Promise<string | null> {
  const input = el('input', {
    class: 'input',
    type: 'text',
    attrs: { value, placeholder: options.placeholder ?? '', spellcheck: 'false', autocomplete: 'off' },
  });
  const field = el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: label }),
    input,
    options.hint ? el('span', { class: 'field-hint', text: options.hint }) : null,
  ]);

  return openDialog({
    title,
    body: field,
    width: 440,
    centered: true,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: options.confirmLabel ?? 'OK', value: 'ok', primary: true },
    ],
  }).then((result) => {
    if (result !== 'ok') return null;
    input.value = input.value.trim();
    return input.value;
  });
}

export function confirmDialog(
  title: string,
  message: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return openDialog({
    title,
    body: message,
    width: 420,
    centered: true,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      {
        label: options.confirmLabel ?? 'Delete',
        value: 'confirm',
        primary: !options.danger,
        danger: options.danger,
      },
    ],
  }).then((result) => result === 'confirm');
}
