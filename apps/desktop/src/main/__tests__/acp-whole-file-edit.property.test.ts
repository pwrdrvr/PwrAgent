import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry, AppServerThreadFileDiff } from "@pwragent/shared";
import { acpDiffContentIsWholeFile } from "../acp/acp-file-edit";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";
import { applyUnifiedDiff, fileLines, parseHunks } from "./helpers/unified-diff";

// ACP `diff` content is `{path, oldText, newText}` with no position. Gemini
// CLI 0.46 and Qwen Code 0.26.9 put the whole file before and after the edit
// there, so line 1 is line 1 and a real line diff is possible. Kimi Code 0.34
// puts the edit's `old_string` and `new_string` there: a snippet with no
// position, which must never be given invented line numbers. The two shapes
// are identical on the wire, so the agent decides which one it is.

const sessionId = "session-whole-file";
const filePath = "/work/notes/checkers.md";

function activities(normalizer: AcpSessionReplayNormalizer): AppServerThreadActivityEntry[] {
  return normalizer.replay().entries.filter(
    (entry): entry is AppServerThreadActivityEntry => entry.type === "activity",
  );
}

/**
 * The frames Gemini CLI 0.46 sends for one `replace` (from its ACP agent):
 * an in-progress `tool_call` with no content, then the completing update with
 * the whole file before and after. Qwen Code sends the same, without `_meta`.
 */
function wholeFileEditFrames(params: {
  id: string;
  oldText: string | null;
  newText: string;
  meta?: Record<string, unknown>;
}): Record<string, unknown>[] {
  return [
    {
      sessionUpdate: "tool_call",
      toolCallId: params.id,
      status: "in_progress",
      title: "checkers.md: Rule 2 => Rule 2, revised",
      content: [],
      locations: [{ path: filePath }],
      kind: "edit",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: params.id,
      status: "completed",
      title: "checkers.md: Rule 2 => Rule 2, revised",
      content: [{
        type: "diff",
        path: filePath,
        oldText: params.oldText,
        newText: params.newText,
        ...(params.meta ? { _meta: params.meta } : {}),
      }],
      locations: [{ path: filePath }],
      kind: "edit",
    },
  ];
}

/** The frames Kimi Code 0.34 sends for one `Edit`: the snippet, no position. */
function snippetEditFrames(params: {
  id: string;
  oldString: string;
  newString: string;
}): Record<string, unknown>[] {
  const rawInput = {
    path: filePath,
    old_string: params.oldString,
    new_string: params.newString,
  };
  const diff = {
    type: "diff",
    path: filePath,
    oldText: params.oldString,
    newText: params.newString,
  };
  return [
    {
      sessionUpdate: "tool_call",
      toolCallId: params.id,
      title: "Edit",
      kind: "edit",
      status: "pending",
      rawInput,
      content: [diff],
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: params.id,
      status: "completed",
      content: [diff],
    },
  ];
}

function replay(backendId: string, frames: Record<string, unknown>[]): AcpSessionReplayNormalizer {
  const normalizer = new AcpSessionReplayNormalizer({
    wholeFileDiffContent: acpDiffContentIsWholeFile(backendId),
  });
  frames.forEach((update, index) => {
    normalizer.apply({ sessionId, receivedAt: 1_000 + index, update });
  });
  return normalizer;
}

function fileDiffOf(normalizer: AcpSessionReplayNormalizer): AppServerThreadFileDiff | undefined {
  return activities(normalizer)[0]?.details[0]?.fileDiff;
}

/** The fewest lines a line diff can remove and add: the LCS distance. */
function minimalEditLines(oldLines: string[], newLines: string[]): number {
  let previous = new Array<number>(newLines.length + 1).fill(0);
  for (const oldLine of oldLines) {
    const current = [0];
    for (let j = 0; j < newLines.length; j += 1) {
      current.push(
        oldLine === newLines[j]
          ? previous[j]! + 1
          : Math.max(previous[j + 1]!, current[j]!),
      );
    }
    previous = current;
  }
  return oldLines.length + newLines.length - 2 * previous[newLines.length]!;
}

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}: item number ${index + 1}`);
}

describe("whole-file ACP edit diffs", () => {
  it("shows two distant changes as two hunks", () => {
    const oldLines = numbered(40);
    const newLines = [...oldLines];
    newLines[4] = "line 5: item number FIVE";
    newLines[34] = "line 35: item number THIRTY-FIVE";
    const fileDiff = fileDiffOf(replay("acp:gemini", wholeFileEditFrames({
      id: "call-1",
      oldText: `${oldLines.join("\n")}\n`,
      newText: `${newLines.join("\n")}\n`,
      meta: { kind: "modify" },
    })));

    expect(fileDiff).toMatchObject({ kind: "update", additions: 2, removals: 2 });
    expect(fileDiff?.diff).toBe([
      "diff --git a/work/notes/checkers.md b/work/notes/checkers.md",
      "--- a/work/notes/checkers.md",
      "+++ b/work/notes/checkers.md",
      "@@ -2,7 +2,7 @@",
      " line 2: item number 2",
      " line 3: item number 3",
      " line 4: item number 4",
      "-line 5: item number 5",
      "+line 5: item number FIVE",
      " line 6: item number 6",
      " line 7: item number 7",
      " line 8: item number 8",
      "@@ -32,7 +32,7 @@",
      " line 32: item number 32",
      " line 33: item number 33",
      " line 34: item number 34",
      "-line 35: item number 35",
      "+line 35: item number THIRTY-FIVE",
      " line 36: item number 36",
      " line 37: item number 37",
      " line 38: item number 38",
    ].join("\n"));
  });

  it("shows a file Qwen created from nothing as an added file", () => {
    const fileDiff = fileDiffOf(replay("acp:qwen", wholeFileEditFrames({
      id: "call-new",
      oldText: "",
      newText: "hello\nworld\n",
    })));
    expect(fileDiff).toMatchObject({ kind: "add", additions: 2, removals: 0 });
    expect(fileDiff?.diff).toContain("--- /dev/null\n+++ b/work/notes/checkers.md\n@@ -0,0 +1,2 @@\n+hello\n+world");
  });

  it("keeps the diff cap for a whole file", () => {
    const oldText = `${numbered(6_000).join("\n")}\n`;
    const newText = `${numbered(6_000).map((line) => `${line} changed`).join("\n")}\n`;
    const fileDiff = fileDiffOf(replay("acp:gemini", wholeFileEditFrames({
      id: "call-big",
      oldText,
      newText,
    })));
    expect(fileDiff).toMatchObject({
      kind: "update",
      diff: "",
      additions: 6_000,
      removals: 6_000,
      omittedReason: "This diff is too large to show.",
    });
    expect(fileDiff?.originalLength).toBeGreaterThan(256 * 1024);
  });

  it("draws no diff for Kimi's snippet, which has no position", () => {
    const [activity] = activities(replay("acp:kimi", snippetEditFrames({
      id: "call-kimi",
      oldString: "item number 5",
      newString: "item number FIVE",
    })));
    expect(activity?.summary).toBe("Edited checkers.md");
    expect(activity?.details[0]?.fileDiff).toBeUndefined();
  });

  it("property: applying the transcript diff to the old file yields the new file, minimally", () => {
    const line = fc.constantFrom("a", "b", "c", "", "  d");
    const edit = fc.record({
      at: fc.nat(),
      remove: fc.nat({ max: 3 }),
      insert: fc.array(line, { maxLength: 3 }),
    });
    const scenario = fc.record({
      backendId: fc.constantFrom("acp:gemini", "acp:qwen"),
      oldLines: fc.array(line, { maxLength: 60 }),
      edits: fc.array(edit, { minLength: 1, maxLength: 4 }),
      newline: fc.boolean(),
    });

    fc.assert(
      fc.property(scenario, ({ backendId, oldLines: lines, edits, newline }) => {
        const edited = [...lines];
        for (const { at, remove, insert } of edits) {
          edited.splice(at % (edited.length + 1), remove, ...insert);
        }
        const text = (fileLinesOf: string[]) =>
          fileLinesOf.length === 0 ? "" : `${fileLinesOf.join("\n")}${newline ? "\n" : ""}`;
        const oldText = text(lines);
        const newText = text(edited);
        // Without a final newline, a last empty line is no line at all.
        const oldLines = fileLines(oldText);
        const newLines = fileLines(newText);
        const fileDiff = fileDiffOf(replay(backendId, wholeFileEditFrames({
          id: "call-prop",
          oldText,
          newText,
        })));
        if (oldLines.join("\n") === newLines.join("\n") && oldLines.length === newLines.length) {
          expect(fileDiff).toBeUndefined();
          return;
        }
        expect(fileDiff).toBeDefined();
        const diff = fileDiff!.diff;
        expect(applyUnifiedDiff(oldLines, diff)).toEqual(newLines);
        const hunks = parseHunks(diff);
        const changed = hunks.flatMap((hunk) => hunk.body);
        const additions = changed.filter((row) => row.startsWith("+")).length;
        const removals = changed.filter((row) => row.startsWith("-")).length;
        expect(fileDiff!.additions).toBe(additions);
        expect(fileDiff!.removals).toBe(removals);
        // A real line diff, not one hunk from the first change to the last.
        expect(additions + removals).toBe(minimalEditLines(oldLines, newLines));
        for (const hunk of hunks) {
          // At most three lines of context at either end, and an unchanged
          // run inside a hunk is short enough that splitting it would not
          // leave two hunks with three lines of context each.
          const runs = hunk.body
            .map((row) => (row.startsWith(" ") ? "c" : "x"))
            .join("")
            .split("x");
          expect(runs[0]!.length).toBeLessThanOrEqual(3);
          expect(runs.at(-1)!.length).toBeLessThanOrEqual(3);
          for (const run of runs.slice(1, -1)) {
            expect(run.length).toBeLessThanOrEqual(6);
          }
        }
        expect(fileDiff!.kind).toBe(oldLines.length === 0 ? "add" : "update");
      }),
      { numRuns: 500 },
    );
  });

  it("property: an agent that is not known to send whole files never gets line numbers", () => {
    const backendId = fc.oneof(
      fc.constantFrom("acp:kimi", "acp:grok", "acp:opencode"),
      fc.stringMatching(/^acp:[a-z]{3,10}$/u).filter((id) => !acpDiffContentIsWholeFile(id)),
    );
    const text = fc.array(fc.constantFrom("a", "b", "c", ""), { minLength: 1, maxLength: 6 })
      .map((lines) => lines.join("\n"));

    fc.assert(
      fc.property(backendId, text, text, fc.boolean(), (id, oldString, newString, opening) => {
        const frames = snippetEditFrames({ id: "call-snippet", oldString, newString });
        const fileDiff = fileDiffOf(replay(id, opening ? frames.slice(0, 1) : frames));
        expect(fileDiff).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });
});
