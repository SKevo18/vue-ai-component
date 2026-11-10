/**
 * the sign-in code in pasted text, or null: `code#state`, a bare code, or a callback address with `code` in its query.
 * A short or spaced fragment is not a code, so a partial paste never submits.
 */
export function pastedSignInCode(text: string): string | null {
  const s = text.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      return url.searchParams.get("code") || url.searchParams.get("error") ? s : null;
    } catch {
      return null;
    }
  }
  return s.split("#")[0]!.length >= 16 && !/\s/.test(s) ? s : null;
}

/** stricter, for clipboard text the user did not paste themselves */
export function clipboardSignInCode(text: string): string | null {
  const s = text.trim();
  if (/^[\w-]{20,}#[\w-]{8,}$/.test(s) || /^4\/[\w-]{20,}$/.test(s)) return s;
  return /^https?:\/\/\S+[?&]code=/.test(s) ? pastedSignInCode(s) : null;
}
