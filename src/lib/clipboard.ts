/**
 * Clipboard access.
 *
 * `navigator.clipboard` only exists in a secure context, so copying has to be
 * able to fail without breaking the caller.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
