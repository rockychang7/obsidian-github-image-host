import { GitHubClient, ReauthRequiredError, refreshAccessToken } from "./github";
import { TokenSet, needsRenewal, refreshExpired } from "./token";
import type { GhiuSettings } from "./settings";

/**
 * Owns the stored credentials and keeps them valid.
 *
 * When the OAuth app issues expiring tokens, the access token lasts eight hours
 * and comes with a refresh token good for six months. Renewing needs no client
 * secret for device-flow tokens, which is the only reason an open-source client
 * can support expiry at all.
 */
export class Auth {
  /** In-flight renewal, shared so a burst of uploads triggers exactly one. */
  private renewal: Promise<string> | null = null;

  constructor(
    private readonly read: () => GhiuSettings,
    private readonly persist: () => Promise<void>,
    private readonly clientId: () => string,
  ) {}

  isConnected(): boolean {
    return Boolean(this.read().token);
  }

  /** A client that always presents a currently valid token. */
  client(): GitHubClient {
    return new GitHubClient(() => this.accessToken());
  }

  async accessToken(): Promise<string> {
    const s = this.read();
    if (!s.token) throw new ReauthRequiredError("Not connected to GitHub");
    if (!needsRenewal(s, Date.now())) return s.token;

    if (!s.refreshToken) {
      // A token that expires with nothing to renew it from: this happens with a
      // manually pasted token, where reconnecting is the only option.
      throw new ReauthRequiredError("Your GitHub access expired — please connect again");
    }

    if (!this.renewal) {
      this.renewal = this.renew().finally(() => {
        this.renewal = null;
      });
    }
    return this.renewal;
  }

  async adopt(tokens: TokenSet, login: string): Promise<void> {
    const s = this.read();
    s.token = tokens.accessToken;
    s.refreshToken = tokens.refreshToken ?? "";
    s.expiresAt = tokens.expiresAt ?? 0;
    s.refreshExpiresAt = tokens.refreshExpiresAt ?? 0;
    s.login = login;
    await this.persist();
  }

  async clear(): Promise<void> {
    const s = this.read();
    s.token = "";
    s.refreshToken = "";
    s.expiresAt = 0;
    s.refreshExpiresAt = 0;
    s.login = "";
    await this.persist();
  }

  /** Human-readable state for the settings screen. */
  describe(): string {
    const s = this.read();
    if (!s.token) return "Not connected";
    const who = s.login ? `Signed in as ${s.login}` : "A token is configured";
    if (!s.expiresAt) return `${who} — token does not expire`;
    if (s.refreshToken) return `${who} — renews automatically`;
    return `${who} — expires ${new Date(s.expiresAt).toLocaleString()}`;
  }

  private async renew(): Promise<string> {
    const s = this.read();
    const clientId = this.clientId();

    if (!clientId) {
      throw new ReauthRequiredError("No OAuth client ID is configured, so access cannot be renewed");
    }
    if (refreshExpired(s, Date.now())) {
      await this.clear();
      throw new ReauthRequiredError("Your GitHub login expired — please connect again");
    }

    try {
      const tokens = await refreshAccessToken(clientId, s.refreshToken);
      await this.adopt(tokens, s.login);
      return tokens.accessToken;
    } catch (err) {
      // Wipe the credentials only when GitHub says they are dead. A network
      // failure leaves them in place so the next attempt can succeed.
      if (err instanceof ReauthRequiredError) await this.clear();
      throw err;
    }
  }
}
