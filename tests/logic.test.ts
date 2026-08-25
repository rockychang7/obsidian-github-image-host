import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFilename,
  joinRepoPath,
  nextIndex,
  renderStem,
  sanitizeSegment,
  type NameContext,
} from "../src/naming.ts";
import { buildLink } from "../src/links.ts";
import { findLocalImageRefs } from "../src/refs.ts";

const NOW = new Date(2026, 7, 25, 14, 5, 9); // 2026-08-25 14:05:09

function ctx(noteName: string, ext = "png"): NameContext {
  return { noteName, ext, now: NOW };
}

// ---- sanitizeSegment ----

test("keeps spaces, because GitHub encodes them as %20", () => {
  assert.equal(sanitizeSegment("my note - figure"), "my note - figure");
});

test("strips parentheses, which would terminate a markdown link early", () => {
  assert.equal(sanitizeSegment("shot (1)"), "shot -1");
  assert.ok(!sanitizeSegment("a(b)c").includes("("));
});

test("strips path separators and other reserved characters", () => {
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|", "#", "%", "[", "]"]) {
    assert.ok(!sanitizeSegment(`a${ch}b`).includes(ch), `${ch} survived`);
  }
});

test("leaves full-width brackets alone — they are safe once encoded", () => {
  assert.equal(sanitizeSegment("AI编程最佳实践（2025）"), "AI编程最佳实践（2025）");
});

test("collapses runs of hyphens and trims the edges", () => {
  assert.equal(sanitizeSegment("--a---b--"), "a-b");
});

test("caps the length so long note titles cannot blow past path limits", () => {
  assert.ok(sanitizeSegment("x".repeat(400)).length <= 120);
});

// ---- renderStem / buildFilename ----

test("fills every documented token", () => {
  const stem = renderStem("{{noteName}}|{{index}}|{{date}}|{{time}}", ctx("note"), 7);
  assert.equal(stem, "note-07-2026-08-25-140509");
});

test("pads the index to two digits but does not truncate larger numbers", () => {
  assert.equal(renderStem("n{{index}}", ctx("x"), 7), "n07");
  assert.equal(renderStem("n{{index}}", ctx("x"), 123), "n123");
});

test("leaves unknown tokens untouched rather than emptying them", () => {
  assert.ok(renderStem("{{nope}}-{{index}}", ctx("x"), 1).includes("nope"));
});

test("appends the extension separately from the template", () => {
  assert.equal(buildFilename("{{noteName}}-{{index}}", ctx("note", "jpg"), 2), "note-02.jpg");
});

test("falls back to the note name when a template renders to nothing", () => {
  assert.equal(buildFilename("((()))", ctx("my note"), 1), "my note.png");
});

// ---- nextIndex ----

test("continues from the highest number already in the note", () => {
  const template = "{{noteName}} - 图{{index}}";
  const note = [
    "![2026-08-25 笔记 - 图01](https://example.com/a.png)",
    "![2026-08-25 笔记 - 图03](https://example.com/b.png)",
  ].join("\n");
  assert.equal(nextIndex(template, ctx("2026-08-25 笔记"), note), 4);
});

test("starts at 1 in an empty note", () => {
  assert.equal(nextIndex("{{noteName}}-{{index}}", ctx("note"), ""), 1);
});

test("ignores numbers belonging to a different note", () => {
  const note = "![some other note-09](https://example.com/x.png)";
  assert.equal(nextIndex("{{noteName}}-{{index}}", ctx("my note"), note), 1);
});

test("treats a note name containing regex characters literally", () => {
  const name = "javascript.info - 基本规则";
  const note = `![${name}-05](https://example.com/x.png)`;
  assert.equal(nextIndex("{{noteName}}-{{index}}", ctx(name), note), 6);
  // The dot must not act as a wildcard, so a near-miss name must not match.
  assert.equal(nextIndex("{{noteName}}-{{index}}", ctx("javascriptXinfo - 基本规则"), note), 1);
});

test("handles a template with no index at all", () => {
  assert.equal(nextIndex("{{noteName}}-{{timestamp}}", ctx("note"), "anything"), 1);
});

// ---- joinRepoPath ----

test("joins an optional subdirectory and tolerates stray slashes", () => {
  assert.equal(joinRepoPath("", "a.png"), "a.png");
  assert.equal(joinRepoPath("images", "a.png"), "images/a.png");
  assert.equal(joinRepoPath("/images/", "a.png"), "images/a.png");
});

// ---- buildLink ----

const LINK = {
  owner: "octocat",
  repo: "pics",
  branch: "master",
  path: "my note - 图01.png",
  downloadUrl: "https://raw.githubusercontent.com/octocat/pics/master/my%20note%20-%20图01.png",
};

test("raw style returns GitHub's own URL untouched", () => {
  assert.equal(buildLink("raw", LINK), LINK.downloadUrl);
});

test("jsdelivr style encodes the path itself", () => {
  const url = buildLink("jsdelivr", LINK);
  assert.ok(url.startsWith("https://cdn.jsdelivr.net/gh/octocat/pics@master/"));
  assert.ok(!url.includes(" "), "spaces must be encoded");
});

test("custom style fills the documented tokens", () => {
  const url = buildLink("custom", LINK, "https://cdn.example.com/{{owner}}/{{repo}}/{{path}}");
  assert.ok(url.startsWith("https://cdn.example.com/octocat/pics/"));
  assert.ok(!url.includes(" "));
});

// ---- findLocalImageRefs ----

test("finds wiki embeds and keeps the display width", () => {
  const refs = findLocalImageRefs("![[folder/a.png]] and ![[b.jpg|300]]");
  assert.deepEqual(
    refs.map((r) => [r.linkpath, r.size]),
    [
      ["folder/a.png", undefined],
      ["b.jpg", "300"],
    ],
  );
});

test("ignores note links that are not images", () => {
  const refs = findLocalImageRefs("![[Note]] ![[Note#Heading]] ![[Note#^block-id]] ![[file.pdf]]");
  assert.equal(refs.length, 0);
});

test("ignores embeds that already point somewhere remote", () => {
  const note = [
    "![a](https://example.com/a.png)",
    "![b](http://example.com/b.png)",
    "![c](//example.com/c.png)",
    "![d](data:image/png;base64,AAAA)",
  ].join("\n");
  assert.equal(findLocalImageRefs(note).length, 0);
});

test("decodes percent-encoded local paths", () => {
  const refs = findLocalImageRefs("![x](images/my%20note%20-%20a.png)");
  assert.equal(refs[0].linkpath, "images/my note - a.png");
});

test("returns the exact source text so replacement cannot drift", () => {
  const raw = "![[folder/a.png|200]]";
  assert.equal(findLocalImageRefs(`before ${raw} after`)[0].raw, raw);
});
