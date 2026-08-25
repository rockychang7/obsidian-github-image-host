/**
 * Copies the built plugin into a vault so it can be tried out.
 *
 *   node scripts/install-local.mjs "C:/path/to/vault"
 *   OBSIDIAN_VAULT="C:/path/to/vault" npm run install-local
 *
 * The vault path is never committed: it is different for everyone, and for most
 * people it points somewhere personal.
 */

import { copyFile, mkdir, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FILES = ["main.js", "manifest.json", "styles.css"];

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error("Pass a vault path, or set OBSIDIAN_VAULT.");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const target = join(vault, ".obsidian", "plugins", manifest.id);

try {
  await access(join(ROOT, "main.js"));
} catch {
  console.error("main.js is missing — run `npm run build` first.");
  process.exit(1);
}

await mkdir(target, { recursive: true });
for (const file of FILES) {
  await copyFile(join(ROOT, file), join(target, file));
}

console.log(`Installed ${manifest.id} v${manifest.version} into:`);
console.log(`  ${target}`);
console.log("");
console.log("In Obsidian: Settings -> Community plugins -> enable it.");
console.log("After rebuilding, run this again and use the 'Reload app without saving' command.");
