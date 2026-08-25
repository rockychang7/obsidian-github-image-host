import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

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

/** The user has to authorize in a browser before polling will return a token. */
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

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
  // CORS and works identically on desktop and mobile.
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

// ---- device flow (unauthenticated) ----

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
  /** Called on every attempt so the UI can show a countdown. */
  onTick?: (secondsLeft: number) => void;
  /** Set to true to abandon polling (user closed the dialog). */
  shouldStop?: () => boolean;
}

/**
 * Polls until the user finishes authorizing in their browser. GitHub asks
 * clients to respect `interval` and to back off by 5s whenever it says
 * `slow_down`, so both are honoured here rather than hammering the endpoint.
 */
export async function pollForToken(
  clientId: string,
  device: DeviceCode,
  options: PollOptions = {},
): Promise<string> {
  let interval = device.interval;
  const deadline = Date.now() + device.expiresIn * 1000;

  while (Date.now() < deadline) {
    if (options.shouldStop?.()) throw new GitHubError("Authorization cancelled", 0);

    await sleep(interval * 1000);
    options.onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));

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

    if (body.access_token) return body.access_token;

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

function describeDeviceError(code: string): string {
  switch (code) {
    case "expired_token":
      return "The code expired before it was entered — please try again";
    case "access_denied":
      return "Authorization was denied on GitHub";
    case "device_flow_disabled":
      return "Device flow is not enabled for this OAuth app";
    case "incorrect_client_credentials":
      return "The client ID is not valid";
    case "unsupported_grant_type":
      return "GitHub rejected the grant type";
    default:
      return `GitHub returned: ${code}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ---- authenticated calls ----

export class GitHubClient {
  constructor(private readonly token: string) {}

  private async call(
    path: string,
    init: Partial<RequestUrlParam> = {},
  ): Promise<RequestUrlResponse> {
    return send({
      url: path.startsWith("http") ? path : `${API_ROOT}${path}`,
      method: "GET",
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
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
   * Only public repos are listed: a private one cannot serve images anyway,
   * so offering it would just let the user pick a target that silently fails.
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
