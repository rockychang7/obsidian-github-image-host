/**
 * Turns a template plus the current note into a filename for the image repo.
 *
 * The shape of the name is a setting rather than a constant: a pattern that
 * reads naturally to one author is line noise to everyone else, so the default
 * stays language-neutral and users bend it to match whatever they already have.
 */

export interface NameContext {
  /** Note basename without the .md extension. */
  noteName: string;
  /** File extension without the leading dot, already lower-cased. */
  ext: string;
  now: Date;
}

export const DEFAULT_TEMPLATE = "{{noteName}}-{{index}}";

/** Longest stem we will generate, so long note titles cannot blow past path limits. */
const MAX_STEM = 120;

/**
 * Characters that must not reach the filename.
 *
 * Parentheses matter more than they look: `encodeURIComponent` leaves them
 * alone, so a file called `note (1).png` yields a URL containing a literal `)`,
 * which terminates a Markdown `![alt](url)` early and produces a broken image
 * with no obvious cause.
 *
 * Spaces are deliberately kept. They survive as `%20` in the URL GitHub returns,
 * and stripping them would make freshly uploaded images look nothing like the
 * ones already sitting in a user's repository.
 */
const UNSAFE = /[\\/:*?"<>|#%\[\]()]/g;

/** Strips control characters by code point, avoiding escape sequences in a regex. */
function stripControl(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

export function sanitizeSegment(input: string): string {
  return stripControl(input)
    .replace(UNSAFE, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s.\-]+|[\s.\-]+$/g, "")
    .slice(0, MAX_STEM)
    .trim();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function tokenValues(ctx: NameContext): Record<string, string> {
  const d = ctx.now;
  return {
    noteName: ctx.noteName,
    ext: ctx.ext,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    timestamp: String(d.getTime()),
    random: Math.random().toString(36).slice(2, 8),
  };
}

const TOKEN = /\{\{\s*(\w+)\s*\}\}/g;

/** Renders the template into a stem. The extension is appended separately. */
export function renderStem(template: string, ctx: NameContext, index: number): string {
  const values: Record<string, string> = { ...tokenValues(ctx), index: pad(index) };
  const rendered = template.replace(TOKEN, (whole, key: string) =>
    key in values ? values[key] : whole,
  );
  return sanitizeSegment(rendered) || sanitizeSegment(ctx.noteName) || "image";
}

export function buildFilename(template: string, ctx: NameContext, index: number): string {
  return `${renderStem(template, ctx, index)}.${ctx.ext}`;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Placeholder for the number while the template is being turned into a matcher. */
const INDEX_SLOT = "@@INDEX@@";

/**
 * Works out which number the next image in this note should get.
 *
 * Rather than asking GitHub what already exists — a network round trip on every
 * single paste — it derives a pattern from the template and reads the numbers
 * already present in the note. Images are named after their note, so the note
 * itself is an accurate record of which numbers are taken.
 */
export function nextIndex(template: string, ctx: NameContext, noteContent: string): number {
  if (!template.includes("{{index}}")) return 1;

  const values = tokenValues(ctx);
  const withSlot = template.replace(TOKEN, (whole, key: string) =>
    key === "index" ? INDEX_SLOT : key in values ? values[key] : whole,
  );
  // Escaping first keeps user text literal; the slot is plain word characters
  // and passes through untouched, so every index position becomes a group.
  const pattern = escapeRegExp(withSlot).split(INDEX_SLOT).join("(\\d+)");

  let highest = 0;
  for (const match of noteContent.matchAll(new RegExp(pattern, "g"))) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest + 1;
}

/** Joins an optional repo subdirectory onto the filename. */
export function joinRepoPath(directory: string, filename: string): string {
  const clean = directory.replace(/^\/+|\/+$/g, "").trim();
  return clean ? `${clean}/${filename}` : filename;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/**
 * Clipboard images arrive with no useful name — often literally "image.png" —
 * so the extension comes from the MIME type, falling back to the name only when
 * the type is unhelpful.
 */
export function extensionFor(file: File): string {
  const fromMime = MIME_EXT[(file.type || "").toLowerCase()];
  if (fromMime) return fromMime;

  const name = file.name || "";
  const fromName = name.includes(".") ? name.split(".").pop() : "";
  const cleaned = (fromName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned || "png";
}

export function isImage(file: File): boolean {
  if ((file.type || "").startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.name || "");
}
