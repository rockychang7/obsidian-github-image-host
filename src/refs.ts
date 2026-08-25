/**
 * Finds image embeds in note text.
 *
 * Kept free of Obsidian imports so the parsing rules can be exercised on their
 * own — this is the part where a sloppy regex quietly rewrites something it
 * should not have touched.
 */

export interface LocalImageRef {
  /** The exact text in the note, used for replacement. */
  raw: string;
  /** Link target as written, for metadataCache to resolve. */
  linkpath: string;
  /** Obsidian's `|300` display width, preserved if present. */
  size?: string;
}

const WIKI_IMAGE = /!\[\[([^\[\]|]+?)(?:\|([^\[\]]*))?\]\]/g;
const MD_IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/**
 * Returns embeds that still point at a local file.
 *
 * Filtering on the extension is what keeps `![[Note#Heading]]` and
 * documentation that shows `![[image.png]]` as a syntax example out of the
 * results. Anything that slips through is dropped later, when it fails to
 * resolve to a real file in the vault.
 */
export function findLocalImageRefs(content: string): LocalImageRef[] {
  const refs: LocalImageRef[] = [];

  for (const m of content.matchAll(WIKI_IMAGE)) {
    const linkpath = m[1].trim();
    if (!IMAGE_EXT.test(linkpath)) continue;
    refs.push({ raw: m[0], linkpath, size: m[2]?.trim() || undefined });
  }

  for (const m of content.matchAll(MD_IMAGE)) {
    const url = m[2].trim();
    if (/^[a-z]+:/i.test(url) || url.startsWith("//")) continue; // already remote
    const linkpath = decodeURIComponent(url.split("#")[0]);
    if (!IMAGE_EXT.test(linkpath)) continue;
    refs.push({ raw: m[0], linkpath });
  }

  return refs;
}
