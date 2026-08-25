import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GitHubImageUploaderPlugin from "./main";
import { GitHubClient, RepoInfo } from "./github";
import { DeviceFlowModal } from "./auth-modal";
import { LinkStyle, CUSTOM_LINK_HINT } from "./links";
import { DEFAULT_TEMPLATE, buildFilename } from "./naming";
import { FINE_GRAINED_TOKEN_URL, OAUTH_APP_SETUP_URL } from "./config";

export interface GhiuSettings {
  /** Empty until the user connects; set by either auth route. */
  token: string;
  /** Present only when the OAuth app issues expiring tokens. */
  refreshToken: string;
  /** Epoch milliseconds. Zero means the token does not expire. */
  expiresAt: number;
  refreshExpiresAt: number;
  /** Cached so settings can show who is connected without a network call. */
  login: string;
  /** Optional override for users who prefer their own OAuth app. */
  clientId: string;

  owner: string;
  repo: string;
  branch: string;
  /** Subdirectory inside the repo. Empty means the repository root. */
  directory: string;

  template: string;
  linkStyle: LinkStyle;
  customLinkTemplate: string;
  commitMessage: string;

  uploadOnPaste: boolean;
  uploadOnDrop: boolean;
  /** On failure, drop the image into the vault so nothing is ever lost. */
  saveLocalOnFailure: boolean;
  /** For the whole-note command: remove the local file once it is hosted. */
  deleteLocalAfterUpload: boolean;
}

export const DEFAULT_SETTINGS: GhiuSettings = {
  token: "",
  refreshToken: "",
  expiresAt: 0,
  refreshExpiresAt: 0,
  login: "",
  clientId: "",

  owner: "",
  repo: "",
  branch: "",
  directory: "",

  template: DEFAULT_TEMPLATE,
  linkStyle: "raw",
  customLinkTemplate: "",
  commitMessage: "upload {{filename}} from Obsidian",

  uploadOnPaste: true,
  uploadOnDrop: true,
  saveLocalOnFailure: true,
  deleteLocalAfterUpload: false,
};

export class GhiuSettingTab extends PluginSettingTab {
  private repos: RepoInfo[] = [];
  private branches: string[] = [];

  constructor(
    app: App,
    private readonly plugin: GitHubImageUploaderPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderAccount(containerEl);
    this.renderTarget(containerEl);
    this.renderNaming(containerEl);
    this.renderLinks(containerEl);
    this.renderBehavior(containerEl);
  }

  private get s(): GhiuSettings {
    return this.plugin.settings;
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  // ---- account ----

  private renderAccount(root: HTMLElement): void {
    new Setting(root).setName("Account").setHeading();

    if (this.plugin.auth.isConnected()) {
      new Setting(root)
        .setName("Connected")
        .setDesc(this.plugin.auth.describe())
        .addButton((b) =>
          b.setButtonText("Disconnect").setWarning().onClick(async () => {
            await this.plugin.auth.clear();
            this.repos = [];
            this.branches = [];
            this.display();
          }),
        );
      return;
    }

    new Setting(root)
      .setName("Connect to GitHub")
      .setDesc(
        "Authorize in your browser with a short code. The plugin asks only for the " +
          "public_repo scope, so it cannot reach your private repositories.",
      )
      .addButton((b) =>
        b
          .setButtonText("Connect")
          .setCta()
          .onClick(() => {
            const clientId = this.plugin.effectiveClientId();
            if (!clientId) {
              new Notice(
                "No OAuth client ID is configured. Add one under Advanced, or paste a personal access token instead.",
              );
              return;
            }
            new DeviceFlowModal(this.app, clientId, async (tokens, login) => {
              await this.plugin.auth.adopt(tokens, login);
              this.display();
              void this.loadRepos();
            }).open();
          }),
      );

    new Setting(root)
      .setName("Or paste a token")
      .setDesc(
        createFragment((f) => {
          f.appendText("A fine-grained token can be limited to a single repository, which is ");
          f.appendText("narrower than what the browser flow requests. ");
          f.createEl("a", { text: "Create one", href: FINE_GRAINED_TOKEN_URL });
          f.appendText(" with Contents: Read and write.");
        }),
      )
      .addText((t) => {
        t.setPlaceholder("github_pat_...");
        t.inputEl.type = "password";
        t.onChange((value) => {
          this.pendingToken = value.trim();
        });
      })
      .addButton((b) =>
        b.setButtonText("Verify and save").onClick(async () => {
          if (!this.pendingToken) return new Notice("Enter a token first");
          try {
            const login = await GitHubClient.withToken(this.pendingToken).getLogin();
            // A pasted token carries no expiry information, so it is stored as
            // one that never expires and simply stops working when revoked.
            await this.plugin.auth.adopt({ accessToken: this.pendingToken }, login);
            new Notice(`Token works — signed in as ${login}`);
            this.pendingToken = "";
            this.display();
            void this.loadRepos();
          } catch (err) {
            new Notice(`Token rejected: ${message(err)}`);
          }
        }),
      );
  }

  private pendingToken = "";

  // ---- target repository ----

  private renderTarget(root: HTMLElement): void {
    new Setting(root).setName("Destination").setHeading();

    if (!this.plugin.auth.isConnected()) {
      root.createEl("p", {
        text: "Connect an account to choose a repository.",
        cls: "setting-item-description",
      });
      return;
    }

    const repoSetting = new Setting(root)
      .setName("Repository")
      .setDesc(
        "Only public repositories you can push to are listed — a private repo cannot serve images.",
      );

    repoSetting.addDropdown((d) => {
      d.addOption("", this.repos.length ? "Select a repository" : "Load repositories first");
      for (const r of this.repos) d.addOption(r.fullName, r.fullName);
      d.setValue(this.s.owner && this.s.repo ? `${this.s.owner}/${this.s.repo}` : "");
      d.onChange(async (value) => {
        const picked = this.repos.find((r) => r.fullName === value);
        this.s.owner = picked?.owner ?? "";
        this.s.repo = picked?.name ?? "";
        this.s.branch = picked?.defaultBranch ?? "";
        await this.save();
        this.branches = [];
        this.display();
        void this.loadBranches();
      });
    });

    repoSetting.addButton((b) =>
      b.setButtonText(this.repos.length ? "Refresh" : "Load").onClick(() => void this.loadRepos()),
    );

    const branchSetting = new Setting(root).setName("Branch");
    branchSetting.addDropdown((d) => {
      if (this.s.branch) d.addOption(this.s.branch, this.s.branch);
      for (const b of this.branches) if (b !== this.s.branch) d.addOption(b, b);
      d.setValue(this.s.branch);
      d.onChange(async (value) => {
        this.s.branch = value;
        await this.save();
      });
    });
    branchSetting.addButton((b) =>
      b.setButtonText("Load").onClick(() => void this.loadBranches()),
    );

    new Setting(root)
      .setName("Folder in repository")
      .setDesc("Leave empty to upload to the repository root.")
      .addText((t) =>
        t
          .setPlaceholder("images/")
          .setValue(this.s.directory)
          .onChange(async (value) => {
            this.s.directory = value.trim();
            await this.save();
          }),
      );
  }

  private async loadRepos(): Promise<void> {
    if (!this.plugin.auth.isConnected()) return;
    new Notice("Loading repositories...");
    try {
      this.repos = await this.plugin.auth.client().listRepos();
      new Notice(`Found ${this.repos.length} repositories`);
      this.display();
    } catch (err) {
      new Notice(`Could not load repositories: ${message(err)}`);
    }
  }

  private async loadBranches(): Promise<void> {
    if (!this.plugin.auth.isConnected() || !this.s.owner || !this.s.repo) return;
    try {
      this.branches = await this.plugin.auth.client().listBranches(this.s.owner, this.s.repo);
      this.display();
    } catch (err) {
      new Notice(`Could not load branches: ${message(err)}`);
    }
  }

  // ---- naming ----

  private renderNaming(root: HTMLElement): void {
    new Setting(root).setName("File names").setHeading();

    const preview = root.createEl("p", { cls: "setting-item-description ghiu-preview" });
    const refresh = () => {
      const sample = this.app.workspace.getActiveFile()?.basename ?? "My note";
      preview.setText(
        "Preview: " +
          buildFilename(this.s.template, { noteName: sample, ext: "png", now: new Date() }, 3),
      );
    };

    new Setting(root)
      .setName("Name template")
      .setDesc(
        "Available: {{noteName}} {{index}} {{date}} {{time}} {{timestamp}} {{random}}. " +
          "The extension is added automatically. {{index}} continues from the highest " +
          "number already used in the current note.",
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_TEMPLATE)
          .setValue(this.s.template)
          .onChange(async (value) => {
            this.s.template = value || DEFAULT_TEMPLATE;
            await this.save();
            refresh();
          }),
      );

    refresh();
  }

  // ---- links ----

  private renderLinks(root: HTMLElement): void {
    new Setting(root).setName("Links").setHeading();

    new Setting(root)
      .setName("Link style")
      .setDesc("How the URL written into your note is built.")
      .addDropdown((d) =>
        d
          .addOption("raw", "raw.githubusercontent.com (direct)")
          .addOption("jsdelivr", "jsDelivr CDN (faster in some regions)")
          .addOption("custom", "Custom template")
          .setValue(this.s.linkStyle)
          .onChange(async (value) => {
            this.s.linkStyle = value as LinkStyle;
            await this.save();
            this.display();
          }),
      );

    if (this.s.linkStyle === "custom") {
      new Setting(root)
        .setName("Custom URL template")
        .setDesc(CUSTOM_LINK_HINT)
        .addText((t) =>
          t
            .setPlaceholder("https://example.com/{{path}}")
            .setValue(this.s.customLinkTemplate)
            .onChange(async (value) => {
              this.s.customLinkTemplate = value.trim();
              await this.save();
            }),
        );
    }
  }

  // ---- behavior ----

  private renderBehavior(root: HTMLElement): void {
    new Setting(root).setName("Behavior").setHeading();

    new Setting(root).setName("Upload on paste").addToggle((t) =>
      t.setValue(this.s.uploadOnPaste).onChange(async (v) => {
        this.s.uploadOnPaste = v;
        await this.save();
      }),
    );

    new Setting(root).setName("Upload on drop").addToggle((t) =>
      t.setValue(this.s.uploadOnDrop).onChange(async (v) => {
        this.s.uploadOnDrop = v;
        await this.save();
      }),
    );

    new Setting(root)
      .setName("Keep a local copy if upload fails")
      .setDesc("Writes the image into your vault so a network problem never loses it.")
      .addToggle((t) =>
        t.setValue(this.s.saveLocalOnFailure).onChange(async (v) => {
          this.s.saveLocalOnFailure = v;
          await this.save();
        }),
      );

    new Setting(root)
      .setName("Delete local file after uploading it")
      .setDesc('Applies to the "Upload all local images in this note" command.')
      .addToggle((t) =>
        t.setValue(this.s.deleteLocalAfterUpload).onChange(async (v) => {
          this.s.deleteLocalAfterUpload = v;
          await this.save();
        }),
      );

    new Setting(root)
      .setName("Commit message")
      .setDesc("Supports {{filename}} and {{noteName}}.")
      .addText((t) =>
        t.setValue(this.s.commitMessage).onChange(async (value) => {
          this.s.commitMessage = value;
          await this.save();
        }),
      );

    new Setting(root).setName("Advanced").setHeading();

    new Setting(root)
      .setName("OAuth client ID")
      .setDesc(
        createFragment((f) => {
          f.appendText("Leave empty to use the one bundled with the plugin. ");
          f.createEl("a", { text: "Register your own", href: OAUTH_APP_SETUP_URL });
          f.appendText(' and enable "Device Flow" in its settings.');
        }),
      )
      .addText((t) =>
        t
          .setPlaceholder("Ov23li...")
          .setValue(this.s.clientId)
          .onChange(async (value) => {
            this.s.clientId = value.trim();
            await this.save();
          }),
      );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
