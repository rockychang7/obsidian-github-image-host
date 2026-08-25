import { App, Modal, Notice, Setting } from "obsidian";
import {
  DeviceCode,
  DEFAULT_SCOPE,
  GitHubClient,
  TokenSet,
  requestDeviceCode,
  pollForToken,
} from "./github";

/**
 * Walks the user through GitHub's device flow.
 *
 * The point of this flow is that it needs no client secret, so the plugin can
 * ship its client id in plain sight and still let anyone connect their own
 * account. All the user does is read an eight-character code off this dialog
 * and type it into github.com.
 */
export class DeviceFlowModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private readonly clientId: string,
    private readonly onSuccess: (tokens: TokenSet, login: string) => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
    void this.run();
  }

  onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }

  private render(): void {
    this.titleEl.setText("Connect to GitHub");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "Requesting a code from GitHub...",
      cls: "ghiu-status",
    });
  }

  private async run(): Promise<void> {
    let device: DeviceCode;
    try {
      device = await requestDeviceCode(this.clientId, DEFAULT_SCOPE);
    } catch (err) {
      this.showError(err);
      return;
    }
    if (this.cancelled) return;

    this.showCode(device);

    try {
      const tokens = await pollForToken(this.clientId, device, {
        shouldStop: () => this.cancelled,
      });
      const login = await GitHubClient.withToken(tokens.accessToken).getLogin();
      if (this.cancelled) return;
      await this.onSuccess(tokens, login);
      new Notice(`Connected to GitHub as ${login}`);
      this.close();
    } catch (err) {
      if (!this.cancelled) this.showError(err);
    }
  }

  private showCode(device: DeviceCode): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("p", {
      text: "Enter this code on GitHub to finish connecting. This window updates by itself once you are done.",
    });

    const code = contentEl.createDiv({ cls: "ghiu-code" });
    code.setText(device.userCode);

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Copy code")
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(device.userCode);
            new Notice("Code copied");
          }),
      )
      .addButton((b) =>
        b.setButtonText("Open GitHub").onClick(() => {
          window.open(device.verificationUri, "_blank");
        }),
      );

    contentEl.createEl("p", {
      text: `Waiting for authorization at ${device.verificationUri}`,
      cls: "ghiu-status",
    });

    contentEl.createEl("p", {
      text: "The plugin asks only for the public_repo scope, so it cannot see or touch your private repositories.",
      cls: "ghiu-hint",
    });
  }

  private showError(err: unknown): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Could not connect", cls: "ghiu-error" });
    contentEl.createEl("p", {
      text: err instanceof Error ? err.message : String(err),
      cls: "ghiu-status",
    });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Try again")
        .setCta()
        .onClick(() => {
          this.cancelled = false;
          this.render();
          void this.run();
        }),
    );
  }
}
