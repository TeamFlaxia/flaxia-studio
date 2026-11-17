/**
 * Pointer-drag helpers for the resizable panes (explorer sidebar, Test Play
 * preview, bottom panel).
 *
 * The handles are plain separators: a pointer drag resizes, arrow keys nudge
 * the size for keyboard users.
 */

export interface DragDelta {
  x: number;
  y: number;
}

export interface DragHandleOptions {
  /** Called once when the drag starts, before the first move. */
  onStart?: () => void;
  /** Called on every pointer move with the delta since the drag started. */
  onDrag: (delta: DragDelta, event: PointerEvent) => void;
  /** Called once when the pointer is released. */
  onEnd?: () => void;
}

/** Binds a mouse/pointer drag to a handle element. */
export function bindDragHandle(handle: HTMLElement, options: DragHandleOptions): void {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');
    const startX = event.clientX;
    const startY = event.clientY;
    options.onStart?.();

    const onMove = (moveEvent: PointerEvent) => {
      options.onDrag({ x: moveEvent.clientX - startX, y: moveEvent.clientY - startY }, moveEvent);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-resizing');
      options.onEnd?.();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

export interface SeparatorKeyOptions {
  /** `horizontal` separators react to left/right, `vertical` to up/down. */
  axis: 'horizontal' | 'vertical';
  step: number;
  /** Receives the signed step to apply. */
  onStep: (delta: number) => void;
}

/** Makes a separator handle keyboard operable. */
export function bindSeparatorKeys(handle: HTMLElement, options: SeparatorKeyOptions): void {
  handle.addEventListener('keydown', (event) => {
    const back = options.axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const forward = options.axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === back) {
      event.preventDefault();
      options.onStep(-options.step);
      return;
    }
    if (event.key === forward) {
      event.preventDefault();
      options.onStep(options.step);
    }
  });
}
