import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

// Grok opens every tool call with a bare `tool_call` whose title is the
// tool's internal name (`search_replace`, `todo_write`, `spawn_subagent`) and
// sends the descriptive title on later updates. The transcript showed the
// internal name for the whole call: 653 of one operator's Grok tool rows read
// `search_replace`, `search_tool`, `todo_write`, and so on, with no file and
// no diff behind them.

const sessionId = "session-grok";
const filePath = "/work/notes/checkers.md";

function xaiTool(name: string, kind: string, label: string) {
  return { "x.ai/tool": { version: 1, name, kind, namespace: "grok_build", label } };
}

function activities(normalizer: AcpSessionReplayNormalizer): AppServerThreadActivityEntry[] {
  return normalizer.replay().entries.filter(
    (entry): entry is AppServerThreadActivityEntry => entry.type === "activity",
  );
}

/** The frames Grok 1.0.45 sent for one `search_replace`, paths replaced. */
function searchReplaceFrames(params: {
  id: string;
  oldString: string;
  newString: string;
  oldLine: number;
  newLine: number;
  linePrefix?: string;
  contextAfter?: string;
}): Record<string, unknown>[] {
  const rawInput = {
    variant: "SearchReplace",
    file_path: filePath,
    old_string: params.oldString,
    new_string: params.newString,
    replace_all: false,
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
      title: "search_replace",
      rawInput: {
        file_path: filePath,
        new_string: params.newString,
        old_string: params.oldString,
      },
      _meta: xaiTool("search_replace", "edit", "Edit"),
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: params.id,
      kind: "edit",
      title: `Edit \`${filePath}\``,
      content: [diff],
      locations: [{ path: filePath }],
      rawInput,
      _meta: xaiTool("search_replace", "edit", "Edit"),
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: params.id,
      kind: "edit",
      status: "completed",
      title: `Edit \`${filePath}\``,
      content: [{
        ...diff,
        _meta: {
          details: [{
            old_string: params.oldString,
            old_line: params.oldLine,
            new_string: params.newString,
            new_line: params.newLine,
            context_before: "",
            context_after: params.contextAfter ?? "",
            line_prefix: params.linePrefix ?? "",
          }],
        },
      }],
      rawInput,
      rawOutput: { type: "SearchReplace" },
    },
  ];
}

function applyFrames(frames: Record<string, unknown>[]): AcpSessionReplayNormalizer {
  const normalizer = new AcpSessionReplayNormalizer();
  frames.forEach((update, index) => {
    normalizer.apply({ sessionId, receivedAt: 1_000 + index, update });
  });
  return normalizer;
}

/**
 * Applies a unified diff to the lines of a file, failing if any context or
 * removed line does not match what the file holds there.
 */
function applyUnifiedDiff(oldLines: string[], diff: string): string[] {
  const result = [...oldLines];
  let offset = 0;
  const lines = diff.split("\n");
  let index = lines.findIndex((line) => line.startsWith("@@"));
  while (index >= 0 && index < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/u.exec(lines[index] ?? "");
    if (!header) {
      throw new Error(`bad hunk header: ${lines[index]}`);
    }
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2]);
    const newCount = Number(header[4]);
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !lines[index]?.startsWith("@@")) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    const before = body.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const after = body.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    expect(before).toHaveLength(oldCount);
    expect(after).toHaveLength(newCount);
    const at = (oldCount === 0 ? oldStart : oldStart - 1) + offset;
    expect(result.slice(at, at + oldCount)).toEqual(before);
    result.splice(at, oldCount, ...after);
    offset += newCount - oldCount;
  }
  return result;
}

function fileLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}

describe("Grok tool activity", () => {
  it("shows a search_replace as the file it edited, with the diff Grok applied", () => {
    const normalizer = applyFrames(searchReplaceFrames({
      id: "call-1",
      oldString: "Rule 1.\nRule 2.",
      newString: "Rule 1.\nRule 2, revised.",
      oldLine: 12,
      newLine: 12,
      contextAfter: "\nRule 3.\n",
    }));

    const [activity] = activities(normalizer);
    expect(activity).toMatchObject({
      summary: "Edited checkers.md",
      status: "completed",
      details: [{
        kind: "write",
        label: "Edited checkers.md",
        path: filePath,
        fileDiff: {
          kind: "update",
          additions: 1,
          removals: 1,
          diff: [
            "diff --git a/work/notes/checkers.md b/work/notes/checkers.md",
            "--- a/work/notes/checkers.md",
            "+++ b/work/notes/checkers.md",
            "@@ -12,2 +12,2 @@",
            " Rule 1.",
            "-Rule 2.",
            "+Rule 2, revised.",
          ].join("\n"),
        },
      }],
    });
  });

  it("names the file from the opening frame, before Grok reports the diff", () => {
    const [opening] = searchReplaceFrames({
      id: "call-2",
      oldString: "a",
      newString: "b",
      oldLine: 1,
      newLine: 1,
    });
    const [activity] = activities(applyFrames([opening!]));
    expect(activity?.summary).toBe("Edited checkers.md");
    expect(activity?.details[0]).toMatchObject({ kind: "write", path: filePath });
    // No position yet, so no invented line numbers.
    expect(activity?.details[0]?.fileDiff).toBeUndefined();
  });

  it("shows a write as the file it wrote", () => {
    const id = "call-write";
    const normalizer = applyFrames([
      {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: "write",
        rawInput: { file_path: filePath, content: "one\ntwo\n" },
        _meta: xaiTool("write", "write", "Write"),
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
        content: [{
          type: "diff",
          path: filePath,
          oldText: "",
          newText: "one\ntwo\n",
          _meta: {
            details: [{
              old_string: "",
              old_line: 1,
              new_string: "one\ntwo\n",
              new_line: 1,
              context_before: "",
              context_after: "",
              line_prefix: "",
            }],
          },
        }],
      },
    ]);
    const [activity] = activities(normalizer);
    expect(activity?.summary).toBe("Wrote checkers.md");
    expect(activity?.details[0]?.fileDiff).toMatchObject({ additions: 2, removals: 0 });
    expect(activity?.details[0]?.fileDiff?.diff).toContain("@@ -0,0 +1,2 @@\n+one\n+two");
  });

  it("property: a tool's internal name never outlives a descriptive title", () => {
    const toolName = fc.stringMatching(/^[a-z]{3,8}(_[a-z]{3,8}){1,3}$/u);
    const tool = fc.record({
      name: toolName,
      kind: fc.constantFrom("plan", "task", "background_task_action", "kill_task_action"),
      label: fc.constantFrom("Plan", "Subagent", "Background Task", "Kill Task"),
    });
    const descriptive = fc
      .stringMatching(/^[a-z]{3,10}( [a-z]{3,10}){0,3}$/u)
      .map((words) => `Ran ${words}`);
    // Each later update brings a descriptive title, repeats the internal
    // name, or carries only a status, with or without the tool identity.
    const laterUpdate = fc.record({
      title: fc.oneof(
        descriptive,
        fc.constant<"name">("name"),
        fc.constant<undefined>(undefined),
      ),
      declaresTool: fc.boolean(),
      status: fc.constantFrom(undefined, "in_progress", "completed"),
    });

    fc.assert(
      fc.property(tool, fc.array(laterUpdate, { maxLength: 5 }), (declared, updates) => {
        const id = "call-prop";
        const meta = xaiTool(declared.name, declared.kind, declared.label);
        const frames: Record<string, unknown>[] = [
          {
            sessionUpdate: "tool_call",
            toolCallId: id,
            title: declared.name,
            status: "pending",
            rawInput: {},
            _meta: meta,
          },
          ...updates.map((update) => ({
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            ...(update.title === "name"
              ? { title: declared.name }
              : update.title
                ? { title: update.title }
                : {}),
            ...(update.status ? { status: update.status } : {}),
            ...(update.declaresTool ? { _meta: meta } : {}),
          })),
        ];
        const [activity] = activities(applyFrames(frames));
        const firstTitle = updates
          .map((update) => update.title)
          .find((title): title is string => Boolean(title) && title !== "name");
        const expected = firstTitle ?? declared.label;
        expect(activity?.summary).toBe(expected);
        expect(activity?.details[0]?.label).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("property: applying the transcript diff to the old file yields the new file", () => {
    const line = fc.stringMatching(/^[a-c ]{0,6}$/u);
    const scenario = fc
      .record({
        lines: fc.array(line, { minLength: 1, maxLength: 12 }),
        replacement: fc.array(line, { maxLength: 4 }).map((lines) => lines.join("\n")),
        start: fc.nat(),
        length: fc.nat({ max: 30 }),
      })
      .map(({ lines, replacement, start, length }) => {
        const text = `${lines.join("\n")}\n`;
        const from = start % (text.length + 1);
        const to = Math.min(text.length, from + length);
        return { text, from, to, replacement };
      })
      .filter(({ text, from, to, replacement }) => text.slice(from, to) !== replacement);

    fc.assert(
      fc.property(scenario, ({ text, from, to, replacement }) => {
        const oldString = text.slice(from, to);
        const newText = `${text.slice(0, from)}${replacement}${text.slice(to)}`;
        const lineStart = text.lastIndexOf("\n", from - 1) + 1;
        const oldLine = text.slice(0, from).split("\n").length;
        // Grok's context_after starts right after the match and runs a few
        // whole lines; an edit at the end of the file has none.
        const rest = text.slice(to);
        const secondBreak = rest.indexOf("\n", rest.indexOf("\n") + 1);
        const contextAfter = secondBreak < 0 ? rest : rest.slice(0, secondBreak + 1);
        const frames = searchReplaceFrames({
          id: "call-diff",
          oldString,
          newString: replacement,
          oldLine,
          newLine: oldLine,
          linePrefix: text.slice(lineStart, from),
          contextAfter,
        });

        const fileDiff = activities(applyFrames(frames))[0]?.details[0]?.fileDiff;
        if (fileLines(text).join("\n") === fileLines(newText).join("\n")) {
          return;
        }
        expect(fileDiff).toBeDefined();
        expect(applyUnifiedDiff(fileLines(text), fileDiff!.diff)).toEqual(fileLines(newText));
        const changed = fileDiff!.diff.split("\n").slice(3);
        expect(fileDiff!.additions).toBe(changed.filter((row) => row.startsWith("+")).length);
        expect(fileDiff!.removals).toBe(changed.filter((row) => row.startsWith("-")).length);
      }),
      { numRuns: 500 },
    );
  });
});
