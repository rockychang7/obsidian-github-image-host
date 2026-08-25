/** Builds the URL that ends up in the note, from the file GitHub just accepted. */

export type LinkStyle = "raw" | "jsdelivr" | "custom";

export interface LinkContext {
  owner: string;
  repo: string;
  branch: string;
  /** Path inside the repository, unencoded. */
  path: string;
  /** The `download_url` GitHub returned, already correctly percent-encoded. */
  downloadUrl: string;
}

export const CUSTOM_LINK_HINT =
  "{{owner}} {{repo}} {{branch}} {{path}} — path is percent-encoded";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function buildLink(
  style: LinkStyle,
  ctx: LinkContext,
  customTemplate = "",
): string {
  switch (style) {
    case "jsdelivr":
      // A public CDN in front of the same repository. Noticeably faster in some
      // regions, at the cost of a cache that can lag behind a replaced file.
      return `https://cdn.jsdelivr.net/gh/${ctx.owner}/${ctx.repo}@${ctx.branch}/${encodePath(ctx.path)}`;

    case "custom":
      return customTemplate
        .replace(/\{\{\s*owner\s*\}\}/g, ctx.owner)
        .replace(/\{\{\s*repo\s*\}\}/g, ctx.repo)
        .replace(/\{\{\s*branch\s*\}\}/g, ctx.branch)
        .replace(/\{\{\s*path\s*\}\}/g, encodePath(ctx.path));

    case "raw":
    default:
      // Preferring GitHub's own value over a hand-built URL is what keeps
      // filenames with spaces and non-ASCII characters working.
      return ctx.downloadUrl;
  }
}
