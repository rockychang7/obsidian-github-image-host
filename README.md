# GitHub Image Host

An Obsidian plugin that uploads images to a GitHub repository as you paste them, and writes the public link into your note.

Your vault stays free of binary attachments; the images live in a repository you control.

```
paste a screenshot  ->  uploaded to your repo  ->  ![shot-01](https://raw.githubusercontent.com/you/pics/main/shot-01.png)
```

## Why another one

Most image-upload plugins ask you to install a separate desktop app, or to paste a token you had to go and create by hand. This one connects through GitHub's device flow: you click a button, type an eight-character code on github.com, and you are done.

It also asks for the `public_repo` scope and nothing else, so **it cannot read or write your private repositories**. That is not a policy — GitHub enforces it. Image hosting needs a public repository anyway: raw URLs from a private repo require credentials and will not render.

## Install

Not yet in the community plugin browser. Until then:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest).
2. Put them in `<vault>/.obsidian/plugins/github-image-host/`.
3. Enable the plugin in **Settings -> Community plugins**.

## Setup

Open **Settings -> GitHub Image Host**.

### 1. Connect an account

Two ways, pick either:

**Browser flow** — click **Connect**, then enter the code shown on `github.com/login/device`. Nothing to create, nothing to copy.

Access lasts eight hours and renews itself in the background for six months, after which you connect once more. Renewal needs no client secret, because GitHub waives that requirement for tokens issued through the device flow — which is the only reason an open-source client can use expiring tokens at all.

**Personal access token** — paste a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Contents: Read and write**. This is the narrower option: a fine-grained token can be limited to one single repository, tighter than the `public_repo` scope the browser flow requests. Such a token does not expire and is never renewed; it simply stops working when you revoke it.

> Forking this plugin? Register your own OAuth app (**GitHub Settings -> Developer settings -> OAuth Apps**), turn on **Enable Device Flow** in its settings — it is off by default — and replace the client ID in `src/config.ts`. Users can also paste their own under **Advanced**.

### 2. Pick a destination

Click **Load** next to **Repository**. Only public repositories you can push to are listed. Choose one, then a branch, and optionally a folder inside the repository.

### 3. Paste an image

That is the whole setup. Paste or drop an image into any note.

## Settings

| Setting | What it does |
| --- | --- |
| **Name template** | How uploaded files are named. See below. |
| **Link style** | `raw.githubusercontent.com`, jsDelivr CDN, or your own URL template. |
| **Folder in repository** | Subdirectory to upload into. Empty means the repository root. |
| **Upload on paste / drop** | Turn either trigger off. |
| **Keep a local copy if upload fails** | Writes the image into your vault so a network problem never loses it. |
| **Delete local file after uploading** | Applies to the whole-note command below. |
| **Commit message** | Supports `{{filename}}` and `{{noteName}}`. |

### Name template

| Token | Example |
| --- | --- |
| `{{noteName}}` | `Reading notes` |
| `{{index}}` | `01`, `02`, ... |
| `{{date}}` | `2026-08-25` |
| `{{time}}` | `140509` |
| `{{timestamp}}` | `1787654709000` |
| `{{random}}` | `k3f9a2` |

The extension is appended automatically.

`{{index}}` continues from the highest number already present in the current note, so images stay in reading order without a round trip to GitHub on every paste. If a name turns out to be taken anyway, the number is bumped rather than overwriting the file that is already there.

Characters that break Markdown links — parentheses especially — are stripped from generated names. Spaces are kept: they survive as `%20` in the URL, and removing them would make new uploads look nothing like whatever is already in your repository.

## Commands

**Upload all local images in this note** — uploads every image the note still references locally and rewrites the links. Useful after pasting content from elsewhere, or to migrate an old note.

## What happens when an upload fails

The placeholder in your note is replaced with a local embed and the image is written into your vault. You keep the image, and you can retry later with the command above. If the plugin is not configured at all it does not intercept the paste, so Obsidian saves the attachment exactly as it normally would.

## Development

```bash
npm install
npm run dev                                    # watch build
npm test                                       # logic tests, no Obsidian needed
npm run build                                  # type-check + production bundle
npm run install-local -- "C:/path/to/vault"    # copy the build into a vault
```

After reinstalling, run **Reload app without saving** from the command palette.

`src/naming.ts`, `src/links.ts`, `src/refs.ts` and `src/token.ts` import nothing from Obsidian, which is what lets the tests run under plain Node. Those four hold the rules worth being sure about: how names are generated, which embeds get rewritten, how URLs are built, and when credentials are considered expired.

## License

MIT
