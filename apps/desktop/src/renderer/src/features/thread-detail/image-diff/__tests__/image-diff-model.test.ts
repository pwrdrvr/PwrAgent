import { describe, expect, it } from "vitest";
import pixelmatch from "pixelmatch";
import {
  buildSequence,
  commitFileImageEntry,
  indexOfStop,
  isPreviewableImage,
  otherChangeImageEntry,
  planDiff,
  referenceExtent,
  resolvedSides,
  stepFile,
  stepStop,
  type ImageDiffEntry,
} from "../image-diff-model";
import { DIFF_COLOR, DIFF_OPTIONS } from "../pixel-diff-options";

function change(repoPath: string, status: "modified" | "untracked" | "deleted") {
  return otherChangeImageEntry(
    { path: `/repo/${repoPath}`, repoPath, status, staged: false, unstaged: true, binary: true },
    "/repo",
  );
}

const commit = { sha: "c".repeat(40), shortSha: "ccccccc" };

describe("image diff model", () => {
  it("previews only binaries with a raster extension", () => {
    expect(isPreviewableImage({ binary: true, repoPath: "a/boiler.PNG" })).toBe(true);
    expect(isPreviewableImage({ binary: true, repoPath: "a/sprite.webp" })).toBe(true);
    // SVG is text, and its edits read as a text diff already.
    expect(isPreviewableImage({ binary: true, repoPath: "a/logo.svg" })).toBe(false);
    expect(isPreviewableImage({ binary: false, repoPath: "a/boiler.png" })).toBe(false);
    expect(isPreviewableImage({ binary: true, repoPath: "a/model.glb" })).toBe(false);
  });

  it("walks every file's items in rail order, adds and deletes contributing one stop", () => {
    const entries = [change("a.png", "modified"), change("b.png", "untracked"), change("c.png", "deleted")];
    const sequence = buildSequence(entries, (entry) => resolvedSides(entry, () => "pending"));
    expect(sequence.map((stop) => `${stop.entryKey.split("/").pop()}:${stop.item}`)).toEqual([
      "a.png:before",
      "a.png:after",
      "a.png:diff",
      "b.png:after",
      "c.png:before",
    ]);
  });

  it("compares a commit against its first parent and learns adds from a missing parent blob", () => {
    const entry = commitFileImageEntry(
      commit,
      { path: "/repo/art/new.png", repoPath: "art/new.png", binary: true },
      "/repo",
    );
    expect(entry.before).toEqual({ kind: "commitParent", sha: commit.sha });
    expect(entry.after).toEqual({ kind: "commit", sha: commit.sha });
    expect(resolvedSides(entry, () => "pending")).toEqual(["before", "after"]);
    expect(resolvedSides(entry, (side) => (side === "before" ? "missing" : "present"))).toEqual(["after"]);
  });

  it("drops a status-known side that reads missing, as a rename's Before does", () => {
    const renamed = change("art/renamed.png", "modified");
    expect(resolvedSides(renamed, (side) => (side === "before" ? "missing" : "present"))).toEqual(["after"]);
    // A delete whose one side also reads missing keeps it, to say so.
    expect(resolvedSides(change("art/gone.png", "deleted"), () => "missing")).toEqual(["before"]);
  });

  it("keeps the viewer on the same file when its current item disappears", () => {
    const entry: ImageDiffEntry = commitFileImageEntry(
      commit,
      { path: "/repo/new.png", repoPath: "new.png", binary: true },
      "/repo",
    );
    const other = change("z.png", "modified");
    const resolved = buildSequence([other, entry], (candidate) =>
      resolvedSides(candidate, (side) => (candidate === entry && side === "before" ? "missing" : "present")));
    expect(indexOfStop(resolved, { entryKey: entry.key, item: "diff" })).toBe(3);
    expect(resolved[3]).toEqual({ entryKey: entry.key, item: "after" });
  });

  it("clamps at both ends instead of wrapping", () => {
    const sequence = buildSequence([change("a.png", "modified")], (entry) => entry.sides ?? []);
    expect(stepStop(sequence, 0, -1)).toBe(0);
    expect(stepStop(sequence, 2, 1)).toBe(2);
    expect(stepStop([], 0, 1)).toBe(0);
  });

  it("jumps by file, returning to the current file's start before the previous file", () => {
    const sequence = buildSequence(
      [change("a.png", "modified"), change("b.png", "untracked"), change("c.png", "modified")],
      (entry) => entry.sides ?? [],
    );
    // a:before a:after a:diff b:after c:before c:after c:diff
    expect(stepFile(sequence, 1, 1)).toBe(3);
    expect(stepFile(sequence, 3, 1)).toBe(4);
    expect(stepFile(sequence, 6, 1)).toBe(6);
    expect(stepFile(sequence, 6, -1)).toBe(4);
    expect(stepFile(sequence, 4, -1)).toBe(3);
    expect(stepFile(sequence, 3, -1)).toBe(0);
    expect(stepFile(sequence, 0, -1)).toBe(0);
  });

  it("frames every revision in the larger box", () => {
    expect(referenceExtent([{ w: 100, h: 40 }, { w: 60, h: 80 }])).toEqual({ w: 100, h: 80 });
    expect(referenceExtent([undefined, undefined])).toBeUndefined();
  });

  it("plans a comparison of unequal sizes instead of refusing it", () => {
    expect(planDiff({ w: 64, h: 64 }, { w: 64, h: 64 })).toEqual({
      size: { w: 64, h: 64 },
      fit: "anchor",
      canStretch: false,
    });
    // Same shape: a 2x export against its 1x twin scales to match by default.
    const twin = planDiff({ w: 2048, h: 1024 }, { w: 1024, h: 512 });
    expect(twin).toMatchObject({ size: { w: 2048, h: 1024 }, fit: "stretch", canStretch: true });
    expect(planDiff({ w: 2048, h: 1024 }, { w: 1024, h: 512 }, false).fit).toBe("anchor");
    // Different shapes anchor on the union, never downscaling the larger.
    expect(planDiff({ w: 100, h: 50 }, { w: 80, h: 80 })).toMatchObject({
      size: { w: 100, h: 80 },
      fit: "anchor",
      canStretch: false,
    });
  });

  it("drives the real pixelmatch with the diff colors, not its default red", () => {
    const before = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const after = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const output = new Uint8ClampedArray(8);
    const changed = pixelmatch(before, after, output, 2, 1, DIFF_OPTIONS);
    expect(changed).toBe(1);
    expect([...output.slice(4, 7)]).toEqual(DIFF_COLOR);
  });
});
