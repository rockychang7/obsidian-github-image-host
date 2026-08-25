import {
  App,
  Editor,
  MarkdownFileInfo,
  MarkdownView,
  Notice,
  TFile,
  arrayBufferToBase64,
  normalizePath,
} from "obsidian";
import type { Auth } from "./auth";
import { ReauthRequiredError, isAlreadyExists } from "./github";
import { buildLink } from "./links";
import {
  NameContext,
  buildFilename,
  extensionFor,
  isImage,
  joinRepoPath,
  nextIndex,
} from "./naming";
import { findLocalImageRefs } from "./refs";
import type { GhiuSettings } from "./settings";

/** How many times to bump the number when a name is already taken. */
const MAX_NAME_ATTEMPTS = 10;

export interface UploadTarget {
  data: ArrayBuffer;
  ext: string;
}

/** What the uploader needs to know about the note an image is going into. */
interface NoteRef {
  name: string;
  path: string;
}

export class Uploader {
  constructor(
    private readonly app: App,
    private readonly auth: Auth,
    private readonly getSettings: () => GhiuSettings,
  ) {}

  private get settings(): GhiuSettings {
    return this.getSettings();
  }

  /** True when there is enough configuration to attempt an upload. */
  isReady(): boolean {
    const s = this.settings;
    return Boolean(this.auth.isConnected() && s.owner && s.repo && s.branch);
  }

  describeMissing(): string {
    const s = this.settings;
    if (!this.auth.isConnected()) return "Connect a GitHub account in the plugin settings first.";
    if (!s.owner || !s.repo) return "Choose a destination repository in the plugin settings.";
    if (!s.branch) return "Choose a branch in the plugin settings.";
    return "";
  }

  // ---- paste and drop ----

  async handleFiles(
    files: File[],
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    const images = files.filter(isImage);
    if (!images.length) return;

    const note = noteRef(info);
    // Numbering is worked out once, up front. Doing it per file would give every
    // image in a multi-image paste the same starting number and force each one
    // to discover the collision over the network.
    const base = nextIndex(
      this.settings.template,
      { noteName: note.name, ext: extensionFor(images[0]), now: new Date() },
      editor.getValue(),
    );

    for (let i = 0; i < images.length; i++) {
      const file = images[i];
      const token = placeholderToken();
      // The placeholder goes in first so the note never sits there looking as
      // though nothing happened, and a slow upload never blocks typing.
      editor.replaceSelection(placeholderText(token));

      const target: UploadTarget = {
        data: await file.arrayBuffer(),
        ext: extensionFor(file),
      };

      void this.uploadOne(target, note, base + i, (markdown) =>
        replaceInEditor(editor, placeholderText(token), markdown),
      );
    }
  }

  // ---- whole-note command ----

  async uploadAllInNote(view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file) return;

    const refs = findLocalImageRefs(view.editor.getValue());
    if (!refs.length) {
      new Notice("No local images found in this note");
      return;
    }

    new Notice(`Uploading ${refs.length} image${refs.length > 1 ? "s" : ""}...`);
    const note = noteRef(view);
    let done = 0;
    let failed = 0;
    let skipped = 0;

    for (const ref of refs) {
      const target = this.app.metadataCache.getFirstLinkpathDest(ref.linkpath, file.path);
      if (!target) {
        // Not a real file — documentation showing ![[image.png]] as an example,
        // or a link that was already broken before we got here.
        skipped++;
        continue;
      }

      try {
        const index = nextIndex(
          this.settings.template,
          { noteName: note.name, ext: target.extension.toLowerCase(), now: new Date() },
          view.editor.getValue(),
        );
        const result = await this.upload(
          { data: await this.app.vault.readBinary(target), ext: target.extension.toLowerCase() },
          note,
          index,
        );

        if (replaceInEditor(view.editor, ref.raw, embed(result.alt, result.url, ref.size))) {
          done++;
          if (this.settings.deleteLocalAfterUpload) {
            await this.app.fileManager.trashFile(target);
          }
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        console.error("[github-image-host]", err);
      }
    }

    const parts = [`Uploaded ${done}`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} not found`);
    new Notice(parts.join(", ") + (failed ? " — see the console" : ""));
  }

  // ---- core ----

  private async uploadOne(
    target: UploadTarget,
    note: NoteRef,
    index: number,
    write: (markdown: string) => boolean,
  ): Promise<void> {
    try {
      const result = await this.upload(target, note, index);
      write(embed(result.alt, result.url));
    } catch (err) {
      const reason =
        err instanceof ReauthRequiredError
          ? `${err.message} (Settings -> GitHub Image Host)`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error("[github-image-host]", err);

      const fallback = this.settings.saveLocalOnFailure
        ? await this.saveLocally(target, note).catch(() => null)
        : null;

      if (fallback) {
        // The upload failed but the bytes are safe in the vault, so the note
        // still shows the image and it can be retried later with the command.
        write(`![[${fallback}]]`);
        new Notice(`Upload failed (${reason}). Saved into your vault instead.`);
      } else {
        write(`**Image upload failed: ${reason}**`);
        new Notice(`Upload failed: ${reason}`);
      }
    }
  }

  private async upload(
    target: UploadTarget,
    note: NoteRef,
    startIndex: number,
  ): Promise<{ url: string; alt: string; path: string }> {
    if (!this.isReady()) throw new Error(this.describeMissing());

    const s = this.settings;
    const ctx: NameContext = { noteName: note.name, ext: target.ext, now: new Date() };
    // The client renews the access token on demand, so a session left open
    // past the eight-hour expiry keeps working without the user noticing.
    const client = this.auth.client();
    const content = arrayBufferToBase64(target.data);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const filename = buildFilename(s.template, ctx, startIndex + attempt);
      const path = joinRepoPath(s.directory, filename);

      try {
        const result = await client.uploadFile({
          owner: s.owner,
          repo: s.repo,
          branch: s.branch,
          path,
          contentBase64: content,
          message: s.commitMessage
            .replace(/\{\{\s*filename\s*\}\}/g, filename)
            .replace(/\{\{\s*noteName\s*\}\}/g, note.name),
        });

        return {
          url: buildLink(
            s.linkStyle,
            {
              owner: s.owner,
              repo: s.repo,
              branch: s.branch,
              path: result.path,
              downloadUrl: result.downloadUrl,
            },
            s.customLinkTemplate,
          ),
          alt: stripExtension(filename),
          path: result.path,
        };
      } catch (err) {
        lastError = err;
        // Someone — quite possibly a past upload from this same note — already
        // holds this name. Move to the next number instead of overwriting them.
        if (isAlreadyExists(err)) continue;
        throw err;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Could not find a free file name");
  }

  private async saveLocally(target: UploadTarget, note: NoteRef): Promise<string> {
    const ctx: NameContext = { noteName: note.name, ext: target.ext, now: new Date() };
    const filename = buildFilename(this.settings.template, ctx, 1);
    const path = await this.app.fileManager.getAvailablePathForAttachment(filename, note.path);
    await this.app.vault.createBinary(normalizePath(path), target.data);
    return path;
  }
}

// ---- helpers ----

function noteRef(info: MarkdownView | MarkdownFileInfo): NoteRef {
  const file: TFile | null = info.file ?? null;
  return { name: file?.basename ?? "image", path: file?.path ?? "" };
}

function placeholderToken(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Each in-flight upload gets its own token, so pasting several images in a row
 * cannot make one result land in another's placeholder.
 */
function placeholderText(token: string): string {
  return `![uploading ${token}...]()`;
}

function embed(alt: string, url: string, size?: string): string {
  return `![${alt}${size ? `|${size}` : ""}](${url})`;
}

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Replaces the first occurrence of `needle` without touching anything else.
 * Rewriting the whole note with setValue would also work, and would also throw
 * away the cursor position, the scroll offset and the undo history.
 */
function replaceInEditor(editor: Editor, needle: string, replacement: string): boolean {
  const lines = editor.getValue().split("\n");
  for (let line = 0; line < lines.length; line++) {
    const ch = lines[line].indexOf(needle);
    if (ch === -1) continue;
    editor.replaceRange(replacement, { line, ch }, { line, ch: ch + needle.length });
    return true;
  }
  return false;
}

