const EXIT_DURATION_MS = 100;
const EXIT_TIMEOUT_MS = EXIT_DURATION_MS + 80;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function closeWithAnimation(overlay: HTMLElement, done: () => void): void {
  if (overlay.classList.contains('is-closing')) return;
  if (prefersReducedMotion()) {
    overlay.remove();
    done();
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    overlay.removeEventListener('animationend', onAnimationEnd);
    window.clearTimeout(timer);
    overlay.remove();
    done();
  };
  const onAnimationEnd = (event: AnimationEvent) => {
    if (event.target === overlay) finish();
  };
  overlay.classList.add('is-closing');
  overlay.addEventListener('animationend', onAnimationEnd);
  const timer = window.setTimeout(finish, EXIT_TIMEOUT_MS);
}
