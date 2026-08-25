/**
 * Token bookkeeping, kept free of Obsidian imports so the expiry rules can be
 * tested directly. Getting these predicates subtly wrong is the kind of bug
 * that only shows up eight hours into a session.
 */

/**
 * Everything GitHub hands back when it issues credentials.
 *
 * When the OAuth app is set to expire tokens, `accessToken` lasts eight hours
 * and arrives with a `refreshToken` good for six months. When it is not, only
 * `accessToken` is present and the expiry fields stay undefined.
 */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Undefined when the token does not expire. */
  expiresAt?: number;
  refreshExpiresAt?: number;
}

/** The same values once flattened into settings, where absent becomes zero. */
export interface StoredTokens {
  token: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

/** Renew this long before a token lapses, so an upload cannot start on a token that dies mid-flight. */
export const RENEW_MARGIN_MS = 5 * 60 * 1000;

export function toTokenSet(body: Record<string, string>, now: number): TokenSet {
  const at = (value: string | undefined): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? now + n * 1000 : undefined;
  };

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt: at(body.expires_in),
    refreshExpiresAt: at(body.refresh_token_expires_in),
  };
}

/**
 * Zero means "no expiry was ever recorded", which is the case for a pasted
 * token and for OAuth apps that issue non-expiring ones. Reading it as a
 * timestamp instead would put every such token permanently in the past and
 * send the plugin into a renewal loop it can never satisfy.
 */
export function needsRenewal(
  t: StoredTokens,
  now: number,
  marginMs: number = RENEW_MARGIN_MS,
): boolean {
  if (!t.token) return false;
  if (t.expiresAt <= 0) return false;
  return now > t.expiresAt - marginMs;
}

/** True once the refresh token itself is past saving and the user must reconnect. */
export function refreshExpired(t: StoredTokens, now: number): boolean {
  return t.refreshExpiresAt > 0 && now > t.refreshExpiresAt;
}

/** Whether a renewal is even possible, as opposed to needing a fresh authorization. */
export function canRenew(t: StoredTokens, now: number): boolean {
  return Boolean(t.refreshToken) && !refreshExpired(t, now);
}
