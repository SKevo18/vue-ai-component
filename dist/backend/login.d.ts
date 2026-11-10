/**
 * the sign-in code in pasted text, or null: `code#state`, a bare code, or a callback address with `code` in its query.
 * A short or spaced fragment is not a code, so a partial paste never submits.
 */
export declare function pastedSignInCode(text: string): string | null;
/** stricter, for clipboard text the user did not paste themselves */
export declare function clipboardSignInCode(text: string): string | null;
