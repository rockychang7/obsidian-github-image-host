import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { TokenSet, toTokenSet } from "./token";

const API_ROOT = "https://api.github.com";
const WEB_ROOT = "https://github.com";
const API_VERSION = "2022-11-28";

/**
 * Device flow needs no client secret, which is what makes it usable from an
 * open-source client: the client id is public information and shipping it in
 * the bundle leaks nothing.
 * See https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 */
export const DEVICE_CODE_URL = `${WEB_ROOT}/login/device/code`;
export const ACCESS_TOKEN_URL = `${WEB_ROOT}/login/oauth/access_token`;

/**
 * `public_repo` grants read/write on public repositories only and no access at
 * all to private ones. Image hosting requires a public repository anyway —
 * raw URLs from a private repo need credentials and will not render — so the
 * narrower scope costs nothing and is far easier for users to trust.
 */
export const DEFAULT_SCOPE = "public_repo";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Raised when the stored credentials cannot be renewed and the user must reconnect. */
export class ReauthRequiredError extends GitHubError {
  constructor(message: string) {
    super(message, 401);
    this.name = "ReauthRequiredError";
  }
}

/** The user has to authorize in a browser before polling will return a token. */
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type { TokenSet } from "./token";

export interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface UploadResult {
  /** Ready-to-use raw URL, percent-encoded by GitHub itself. */
  downloadUrl: string;
  path: string;
  sha: string;
}

async function send(params: RequestUrlParam): Promise<RequestUrlResponse> {
  // requestUrl goes through Obsidian's native layer, so it is not subject to
  // CORS and behaves the same on desktop and mobile.
  return requestUrl({ ...params, throw: false });
}

function readError(res: RequestUrlResponse, fallback: string): string {
  try {
    const body = res.json as { message?: string; errors?: { message?: string }[] };
    const detail = body?.errors?.map((e) => e.message).filter(Boolean).join("; ");
    return [body?.message, detail].filter(Boolean).join(" — ") || fallback;
  } catch {
    return fallback;
  }
}

// ---- device flow (no credentials needed) ----

export async function requestDeviceCode(
  clientId: string,
  scope = DEFAULT_SCOPE,
): Promise<DeviceCode> {
  const res = await send({
    url: DEVICE_CODE_URL,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });

  if (res.status !== 200) {
    throw new GitHubError(readError(res, "Could not start authorization"), res.status);
  }

  const body = res.json as Record<string, string | number>;
  if (body.error) {
    throw new GitHubError(describeDeviceError(String(body.error)), res.status, body);
  }

  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    expiresIn: Number(body.expires_in ?? 900),
    interval: Number(body.interval ?? 5),
  };
}

export interface PollOptions {
  /** Set to true to abandon polling, for instance when the dialog is closed. */
  shouldStop?: () => boolean;
}

/**
 * Polls until the user finishes authorizing in their browser. GitHub asks
 * clients to respect `interval` and to back off by five seconds whenever it
 * answers `slow_down`, so both are honoured rather than hammering the endpoint.
 */
export async function pollForToken(
  clientId: string,
  device: DeviceCode,
  options: PollOptions = {},
): Promise<TokenSet> {
  let interval = device.interval;
  const deadline = Date.now() + device.expiresIn * 1000;

  while (Date.now() < deadline) {
    if (options.shouldStop?.()) throw new GitHubError("Authorization cancelled", 0);

    await sleep(interval * 1000);

    const res = await send({
      url: ACCESS_TOKEN_URL,
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const body = (res.json ?? {}) as Record<string, string>;

    if (body.access_token) return toTokenSet(body, Date.now());

    switch (body.error) {
      case "authorization_pending":
        continue; // the user simply has not finished yet
      case "slow_down":
        interval += 5;
        continue;
      case undefined:
        throw new GitHubError(readError(res, "Authorization failed"), res.status, body);
      default:
        throw new GitHubError(describeDeviceError(body.error), res.status, body);
    }
  }

  throw new GitHubError("Authorization timed out — please try again", 0);
}

/**
 * Exchanges a refresh token for a fresh pair.
 *
 * Notably this needs no client secret either: GitHub requires one "unless the
 * user access token was generated using the device flow". Without that carve-out
 * an open-source client could not support expiring tokens at all, and would be
 * stuck asking for credentials that never expire.
 */
export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
): Promise<TokenSet> {
  const res = await send({
    url: ACCESS_TOKEN_URL,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const body = (res.json ?? {}) as Record<string, string>;
  if (body.access_token) return toTokenSet(body, Date.now());

  // Only a definite answer from GitHub means the saved login is beyond saving.
  // Anything else — a malformed body, a 5xx, a captive portal — is treated as a
  // transient failure, because discarding working credentials over a blip would
  // force the user to re-authorize for no reason.
  if (body.error) {
    throw new ReauthRequiredError(
      body.error_description || describeDeviceError(body.error) || "Could not refresh access",
    );
  }

  throw new GitHubError(
    readError(res, `Could not refresh access (HTTP ${res.status})`),
    res.status,
    body,
  );
}

function describeDeviceError(code: string): string {
  switch (code) {
    case "expired_token":
      return "The code expired before it was entered — please try again";
    case "access_denied":
      return "Authorization was denied on GitHub";
    case "device_flow_disabled":
      return 'Device flow is not enabled for this OAuth app — turn on "Enable Device Flow" in its settings';
    case "incorrect_client_credentials":
      return "The client ID is not valid";
    case "unsupported_grant_type":
      return "GitHub rejected the grant type";
    case "bad_refresh_token":
      return "The saved login has expired — please connect again";
    default:
      return code ? `GitHub returned: ${code}` : "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ---- authenticated calls ----

/** Resolves to a currently valid access token, refreshing first if necessary. */
export type TokenProvider = () => string | Promise<string>;

export class GitHubClient {
  constructor(private readonly getToken: TokenProvider) {}

  /** Convenience for one-off calls with a token that needs no renewal. */
  static withToken(token: string): GitHubClient {
    return new GitHubClient(() => token);
  }

  private async call(
    path: string,
    init: Partial<RequestUrlParam> = {},
  ): Promise<RequestUrlResponse> {
    const token = await this.getToken();
    return send({
      url: path.startsWith("http") ? path : `${API_ROOT}${path}`,
      method: "GET",
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  async getLogin(): Promise<string> {
    const res = await this.call("/user");
    if (res.status !== 200) {
      throw new GitHubError(readError(res, "Could not read the account"), res.status);
    }
    return String((res.json as { login: string }).login);
  }

  /**
   * Only public repositories are listed: a private one cannot serve images, so
   * offering it would just let someone pick a target that silently fails.
   */
  async listRepos(): Promise<RepoInfo[]> {
    const found: RepoInfo[] = [];

    for (let page = 1; page <= 10; page++) {
      const res = await this.call(
        `/user/repos?visibility=public&affiliation=owner,collaborator,organization_member` +
          `&sort=pushed&per_page=100&page=${page}`,
      );
      if (res.status !== 200) {
        throw new GitHubError(readError(res, "Could not list repositories"), res.status);
      }

      const batch = res.json as {
        full_name: string;
        name: string;
        owner: { login: string };
        default_branch: string;
        private: boolean;
        permissions?: { push?: boolean };
      }[];

      for (const repo of batch) {
        if (repo.permissions && !repo.permissions.push) continue; // read-only, useless here
        found.push({
          fullName: repo.full_name,
          owner: repo.owner.login,
          name: repo.name,
          defaultBranch: repo.default_branch,
          isPrivate: repo.private,
        });
      }

      if (batch.length < 100) break;
    }

    return found;
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const res = await this.call(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    );
    if (res.status !== 200) {
      throw new GitHubError(readError(res, "Could not list branches"), res.status);
    }
    return (res.json as { name: string }[]).map((b) => b.name);
  }

  /**
   * Creates a file and returns GitHub's own `download_url`.
   *
   * Building that URL by hand is where this kind of code usually breaks:
   * filenames with spaces and non-ASCII characters have to be percent-encoded
   * exactly right. Taking the value GitHub hands back sidesteps the whole class
   * of bug.
   */
  async uploadFile(args: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
    contentBase64: string;
    message: string;
  }): Promise<UploadResult> {
    const encodedPath = args.path.split("/").map(encodeURIComponent).join("/");
    const res = await this.call(
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${encodedPath}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: args.message,
          content: args.contentBase64,
          branch: args.branch,
        }),
      },
    );

    if (res.status === 201 || res.status === 200) {
      const content = (res.json as { content: { download_url: string; path: string; sha: string } })
        .content;
      return { downloadUrl: content.download_url, path: content.path, sha: content.sha };
    }

    throw new GitHubError(
      readError(res, `Upload failed (HTTP ${res.status})`),
      res.status,
      res.json,
    );
  }
}

/**
 * GitHub answers "this file already exists" with 422 and a message about a
 * missing `sha`, which is the signal to pick a different name rather than
 * silently overwrite whatever is already there.
 */
export function isAlreadyExists(err: unknown): boolean {
  if (!(err instanceof GitHubError)) return false;
  if (err.status === 409) return true;
  return err.status === 422 && /sha/i.test(err.message);
}
