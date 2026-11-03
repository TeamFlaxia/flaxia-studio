import { el } from '../lib/dom';
import { type IconName, icon } from '../lib/icons';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

const ICONS: Record<ToastKind, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  error: 'alert',
};

export function toast(title: string, message?: string, kind: ToastKind = 'info', duration = 4200): void {
  const root = document.getElementById('toast-root');
  if (!root) return;

  const node = el('div', { class: `toast ${kind === 'info' ? '' : `is-${kind}`}`.trim(), role: 'status' }, [
    el('div', { class: 'toast-icon' }, [icon(ICONS[kind], 16)]),
    el('div', { class: 'toast-body' }, [
      el('div', { class: 'toast-title', text: title }),
      message ? el('div', { class: 'toast-message', text: message }) : null,
    ]),
  ]);

  root.appendChild(node);
  const remove = () => {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 160);
  };
  const timer = window.setTimeout(remove, duration);
  node.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
  });
}
