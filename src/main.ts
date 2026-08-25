import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin } from "obsidian";
import { Auth } from "./auth";
import { BUNDLED_CLIENT_ID } from "./config";
import { DEFAULT_SETTINGS, GhiuSettingTab, GhiuSettings } from "./settings";
import { Uploader } from "./uploader";

export default class GitHubImageUploaderPlugin extends Plugin {
  settings: GhiuSettings = { ...DEFAULT_SETTINGS };
  auth!: Auth;
  private uploader!: Uploader;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.auth = new Auth(
      () => this.settings,
      () => this.saveSettings(),
      () => this.effectiveClientId(),
    );
    this.uploader = new Uploader(this.app, this.auth, () => this.settings);
    this.addSettingTab(new GhiuSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on("editor-paste", this.onPaste));
    this.registerEvent(this.app.workspace.on("editor-drop", this.onDrop));

    this.addCommand({
      id: "upload-all-local-images",
      name: "Upload all local images in this note",
      editorCallback: (_editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        if (!(ctx instanceof MarkdownView)) return;
        if (!this.requireConfigured()) return;
        void this.uploader.uploadAllInNote(ctx);
      },
    });
  }

  effectiveClientId(): string {
    return this.settings.clientId || BUNDLED_CLIENT_ID;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- events ----

  private onPaste = (
    evt: ClipboardEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void => {
    if (!this.settings.uploadOnPaste) return;
    this.intercept(evt, imageFilesFrom(evt.clipboardData), editor, info);
  };

  private onDrop = (
    evt: DragEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void => {
    if (!this.settings.uploadOnDrop) return;
    this.intercept(evt, imageFilesFrom(evt.dataTransfer), editor, info);
  };

  /**
   * Takes over the event only when there is something to upload and the plugin
   * is actually configured.
   *
   * Bailing out without calling preventDefault matters: an unconfigured or
   * half-configured plugin then behaves as if it were not installed, and
   * Obsidian saves the attachment the way it always does. Swallowing the paste
   * and showing an error instead would leave the user with no image at all.
   */
  private intercept(
    evt: Event,
    files: File[],
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void {
    if (evt.defaultPrevented || !files.length) return;

    if (!this.uploader.isReady()) {
      new Notice(`GitHub Image Uploader: ${this.uploader.describeMissing()}`);
      return; // let Obsidian handle it normally
    }

    evt.preventDefault();
    void this.uploader.handleFiles(files, editor, info);
  }

  private requireConfigured(): boolean {
    if (this.uploader.isReady()) return true;
    new Notice(`GitHub Image Uploader: ${this.uploader.describeMissing()}`);
    return false;
  }
}

function imageFilesFrom(source: DataTransfer | null): File[] {
  if (!source) return [];
  const files = Array.from(source.files ?? []);
  return files.filter((f) => (f.type || "").startsWith("image/") || hasImageName(f));
}

function hasImageName(file: File): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.name || "");
}
