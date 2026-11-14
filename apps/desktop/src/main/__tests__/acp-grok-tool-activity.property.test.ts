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

type LaterFrameOptions = {
  /** Whether each later frame repeats `rawInput`. */
  laterRawInput?: boolean[];
  /** Whether each later frame repeats the x.ai tool identity. */
  laterIdentity?: boolean[];
};

/**
 * The frames Grok 1.0.45 sent for one tool call that reads: the bare opening
 * `tool_call`, the update with the descriptive title and `locations`, and the
 * completing update with the output. Later frames may drop `rawInput` and the
 * x.ai identity, as recorded rollouts show.
 */
function readOnlyToolFrames(params: LaterFrameOptions & {
  id: string;
  name: "read_file" | "list_dir";
  target: string;
  rawInput: Record<string, unknown>;
  variant: string;
  acpKind: string;
  title: string;
  completed: Record<string, unknown>;
}): Record<string, unknown>[] {
  const meta = params.name === "read_file"
    ? xaiTool("read_file", "read", "Read")
    : xaiTool("list_dir", "list", "List Files");
  const later = (index: number) => ({
    ...(params.laterRawInput?.[index] ?? true
      ? { rawInput: { variant: params.variant, ...params.rawInput } }
      : {}),
    ...(params.laterIdentity?.[index] ?? index === 0 ? { _meta: meta } : {}),
  });
  return [
    {
      sessionUpdate: "tool_call",
      toolCallId: params.id,
      title: params.name,
      rawInput: params.rawInput,
      _meta: meta,
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: params.id,
      kind: params.acpKind,
      title: params.title,
      locations: [{ path: params.target }],
      ...later(0),
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: params.id,
      kind: params.acpKind,
      status: "completed",
      title: params.title,
      ...params.completed,
      ...later(1),
    },
  ];
}

function readFileFrames(params: LaterFrameOptions & {
  id: string;
  target: string;
  offset?: number | null;
  limit?: number;
  pages?: string;
}): Record<string, unknown>[] {
  const rawInput: Record<string, unknown> = { target_file: params.target };
  if (params.offset !== undefined) {
    rawInput.offset = params.offset;
  }
  if (params.limit !== undefined) {
    rawInput.limit = params.limit;
  }
  if (params.pages !== undefined) {
    rawInput.pages = params.pages;
  }
  const text = "1\u2192const board = [];\n2\u2192";
  return readOnlyToolFrames({
    ...params,
    name: "read_file",
    rawInput,
    variant: "ReadFile",
    acpKind: "read",
    title: `Read \`${params.target}\``,
    completed: {
      content: [{ type: "content", content: { type: "text", text } }],
      rawOutput: {
        type: "ReadFile",
        FileContent: {
          content: text,
          absolute_path: params.target,
          offset: params.offset ?? null,
          limit: params.limit ?? null,
          total_lines: 2,
        },
      },
    },
  });
}

function listDirFrames(params: LaterFrameOptions & {
  id: string;
  target: string;
}): Record<string, unknown>[] {
  return readOnlyToolFrames({
    ...params,
    name: "list_dir",
    rawInput: { target_directory: params.target },
    variant: "ListDir",
    acpKind: "other",
    title: `List \`${params.target}\``,
    completed: {
      rawOutput: {
        type: "ListDir",
        Content: {
          content: `- ${params.target}\n  - src/\n`,
          absolute_root_path: params.target,
        },
      },
    },
  });
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
    expect(activity?.details[0]?.fileDiff).toMatchObject({
      kind: "add",
      additions: 2,
      removals: 0,
    });
    expect(activity?.details[0]?.fileDiff?.diff).toContain(
      "--- /dev/null\n+++ b/work/notes/checkers.md\n@@ -0,0 +1,2 @@\n+one\n+two",
    );
  });

  it("reads context_after as the lines after the edited line, not the rest of it", () => {
    // Grok 1.0.45 replacing line 39 of a workflow. The match ends at the end
    // of its line, and context_after starts with line 40.
    const normalizer = applyFrames(searchReplaceFrames({
      id: "call-eol",
      oldString: "          node-version: 24.x",
      newString: "          node-version: 24.18.0",
      oldLine: 39,
      newLine: 39,
      contextAfter: "          cache-electron: \"true\"\n\n      - name: Check release metadata\n",
    }));
    expect(activities(normalizer)[0]?.details[0]?.fileDiff?.diff).toBe([
      "diff --git a/work/notes/checkers.md b/work/notes/checkers.md",
      "--- a/work/notes/checkers.md",
      "+++ b/work/notes/checkers.md",
      "@@ -39,1 +39,1 @@",
      "-          node-version: 24.x",
      "+          node-version: 24.18.0",
    ].join("\n"));
  });

  it("keeps a failed edit's reason", () => {
    const [opening] = searchReplaceFrames({
      id: "call-failed",
      oldString: "missing",
      newString: "b",
      oldLine: 1,
      newLine: 1,
    });
    const reason = "The string to replace was not found in the file.";
    const normalizer = applyFrames([
      opening!,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-failed",
        kind: "edit",
        status: "failed",
        locations: [{ path: filePath }],
        content: [{ type: "content", content: { type: "text", text: reason } }],
      },
    ]);
    const [activity] = activities(normalizer);
    expect(activity?.status).toBe("failed");
    expect(activity?.details[0]?.command?.output).toContain(reason);
  });

  it("draws no diff when the call's content names another file", () => {
    const normalizer = applyFrames([{
      sessionUpdate: "tool_call",
      toolCallId: "call-two-files",
      kind: "edit",
      status: "completed",
      title: "Edit two files",
      locations: [{ path: "/work/a.ts" }],
      content: [
        { type: "diff", path: "/work/a.ts", oldText: null, newText: "a\n" },
        { type: "diff", path: "/work/b.ts", oldText: null, newText: "b\n" },
      ],
    }]);
    const [activity] = activities(normalizer);
    expect(activity?.summary).toBe("Edited a.ts");
    expect(activity?.details[0]?.fileDiff).toBeUndefined();
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

  it("shows a read_file as the file it read, with the lines it asked for", () => {
    const target = "/work/tree/apps/desktop/src/checkers.ts";
    const [activity] = activities(applyFrames(readFileFrames({
      id: "call-read",
      target,
      offset: 250,
      limit: 120,
    })));
    expect(activity).toMatchObject({
      summary: "Read checkers.ts (lines 250-369)",
      status: "completed",
      details: [{ kind: "read", label: "Read checkers.ts (lines 250-369)", path: target }],
    });
  });

  it("shows a list_dir as the directory it listed", () => {
    const target = "/work/tree/apps/desktop/";
    const [activity] = activities(applyFrames(listDirFrames({ id: "call-list", target })));
    expect(activity).toMatchObject({
      summary: "Listed desktop",
      status: "completed",
      details: [{ kind: "read", label: "Listed desktop", path: target }],
    });
  });

  it("names a URL read by its file, without the query, and by its host when it has no path", () => {
    const image = "https://images.example.test/media/board%20photo.jpg?name=large#top";
    const [imageRow] = activities(applyFrames(readFileFrames({ id: "call-url", target: image })));
    expect(imageRow?.summary).toBe("Read board photo.jpg");
    expect(imageRow?.details[0]?.path).toBe(image);

    const site = "https://docs.example.test/";
    const [siteRow] = activities(applyFrames(readFileFrames({ id: "call-site", target: site })));
    expect(siteRow?.summary).toBe("Read docs.example.test");
  });

  it("property: a read or listing keeps its own label whatever Grok's later frames carry", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_.-]{0,10}$/u);
    const scenario = fc.record({
      tool: fc.constantFrom<"read_file" | "list_dir">("read_file", "list_dir"),
      segments: fc.array(segment, { minLength: 1, maxLength: 6 }),
      trailingSlash: fc.boolean(),
      offset: fc.option(fc.integer({ min: 1, max: 5_000 }), { nil: undefined }),
      offsetNull: fc.boolean(),
      limit: fc.option(fc.integer({ min: 1, max: 1_000 }), { nil: undefined }),
      pages: fc.option(
        fc.constantFrom("3", "1-10", "11-13"),
        { nil: undefined },
      ),
      // Grok does not always repeat its input or its tool identity.
      laterRawInput: fc.array(fc.boolean(), { minLength: 2, maxLength: 2 }),
      laterIdentity: fc.array(fc.boolean(), { minLength: 2, maxLength: 2 }),
      steps: fc.integer({ min: 1, max: 3 }),
    });

    fc.assert(
      fc.property(scenario, (input) => {
        const name = input.segments.at(-1)!;
        const target = `/${input.segments.join("/")}${input.trailingSlash ? "/" : ""}`;
        const all = input.tool === "read_file"
          ? readFileFrames({
              id: "call-prop-read",
              target,
              offset: input.offset ?? (input.offsetNull ? null : undefined),
              limit: input.limit,
              pages: input.pages,
              laterRawInput: input.laterRawInput,
              laterIdentity: input.laterIdentity,
            })
          : listDirFrames({
              id: "call-prop-list",
              target,
              laterRawInput: input.laterRawInput,
              laterIdentity: input.laterIdentity,
            });
        const [activity] = activities(applyFrames(all.slice(0, input.steps)));

        let expected: string;
        if (input.tool === "list_dir") {
          expected = `Listed ${name}`;
        } else if (input.pages !== undefined) {
          expected = `Read ${name} (${/^\d+$/u.test(input.pages) ? "page" : "pages"} ${input.pages})`;
        } else if (input.limit !== undefined) {
          const from = input.offset ?? 1;
          expected = `Read ${name} (lines ${from}-${from + input.limit - 1})`;
        } else if (input.offset !== undefined && input.offset > 1) {
          expected = `Read ${name} (from line ${input.offset})`;
        } else {
          expected = `Read ${name}`;
        }
        expect(activity?.summary).toBe(expected);
        expect(activity?.details).toHaveLength(1);
        expect(activity?.details[0]).toMatchObject({ kind: "read", label: expected, path: target });
      }),
      { numRuns: 400 },
    );
  });

  // Grok's positions, as the captured rollouts show them: `line_prefix` is
  // the text before the match on its line, the match ends at the end of a
  // line or right after a newline, and `context_after` is the whole lines
  // after the line the match ends on.
  function grokReplacement(text: string, from: number, to: number) {
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const atLineStart = to === 0 || text[to - 1] === "\n";
    const following = atLineStart ? text.slice(to) : text.slice(to + 1);
    const secondBreak = following.indexOf("\n", following.indexOf("\n") + 1);
    return {
      oldString: text.slice(from, to),
      oldLine: text.slice(0, from).split("\n").length,
      linePrefix: text.slice(lineStart, from),
      contextAfter: secondBreak < 0 ? following : following.slice(0, secondBreak + 1),
    };
  }

  /** Offsets where a Grok match can end: a line's end or a line's start. */
  function matchEnds(text: string): number[] {
    const ends = new Set<number>([0, text.length]);
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") {
        ends.add(index);
        ends.add(index + 1);
      }
    }
    return [...ends].sort((left, right) => left - right);
  }

  it("property: applying the transcript diff to the old file yields the new file", () => {
    const line = fc.stringMatching(/^[a-c ]{0,6}$/u);
    const scenario = fc
      .record({
        lines: fc.array(line, { minLength: 1, maxLength: 12 }),
        finalNewline: fc.boolean(),
        replacement: fc.array(line, { maxLength: 4 }).map((lines) => lines.join("\n")),
        replacementNewline: fc.boolean(),
        start: fc.nat(),
        end: fc.nat(),
      })
      .map(({ lines, finalNewline, replacement, replacementNewline, start, end }) => {
        const text = `${lines.join("\n")}${finalNewline ? "\n" : ""}`;
        const ends = matchEnds(text);
        const to = ends[end % ends.length]!;
        const from = start % (to + 1);
        return {
          text,
          from,
          to,
          replacement: `${replacement}${replacementNewline ? "\n" : ""}`,
        };
      })
      .filter(({ text, from, to, replacement }) => text.slice(from, to) !== replacement)
      // Emptying the last line of a file with no final newline ("a" to "")
      // reports exactly what emptying it in "a\n" does: nothing follows
      // either match. The transcript keeps the emptied line, as in the
      // common case of a file that ends with a newline.
      .filter(({ text, from, to, replacement }) => {
        const lineStart = text.lastIndexOf("\n", from - 1) + 1;
        const emptiedLastLine = `${text.slice(lineStart, from)}${replacement}`
          .split("\n")
          .at(-1) === "";
        return !(to === text.length && !text.endsWith("\n") && emptiedLastLine);
      });

    fc.assert(
      fc.property(scenario, ({ text, from, to, replacement }) => {
        const newText = `${text.slice(0, from)}${replacement}${text.slice(to)}`;
        const position = grokReplacement(text, from, to);
        const frames = searchReplaceFrames({
          id: "call-diff",
          oldString: position.oldString,
          newString: replacement,
          oldLine: position.oldLine,
          newLine: position.oldLine,
          linePrefix: position.linePrefix,
          contextAfter: position.contextAfter,
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

  it("property: one call's replacements apply together to yield the new file", () => {
    // replace_all and multi-edit calls report one detail per replacement,
    // each positioned in the file before (old_line) and after (new_line).
    const line = fc.stringMatching(/^[a-c]{1,4}$/u);
    const scenario = fc.record({
      lines: fc.array(line, { minLength: 2, maxLength: 16 }),
      edits: fc.array(
        fc.record({
          at: fc.nat(),
          span: fc.integer({ min: 1, max: 3 }),
          lines: fc.array(fc.stringMatching(/^[x-z]{1,3}$/u), { maxLength: 3 }),
        }),
        { minLength: 1, maxLength: 4 },
      ),
    });

    fc.assert(
      fc.property(scenario, ({ lines, edits }) => {
        // Whole-line replacements over disjoint, ordered ranges, with a line
        // left between ranges so no two hunks share a line.
        const ranges: { start: number; end: number; lines: string[] }[] = [];
        let next = 0;
        for (const edit of edits) {
          const start = next + (edit.at % 3);
          const end = Math.min(lines.length, start + edit.span);
          if (start >= lines.length) break;
          ranges.push({ start, end, lines: edit.lines });
          next = end + 1;
        }
        if (ranges.length === 0) return;
        const text = `${lines.join("\n")}\n`;
        const newLines = [...lines];
        let shift = 0;
        const details = ranges.map((range) => {
          const oldString = `${lines.slice(range.start, range.end).join("\n")}\n`;
          const newString = range.lines.length ? `${range.lines.join("\n")}\n` : "";
          const lineOffset = lines.slice(0, range.start).join("\n").length
            + (range.start > 0 ? 1 : 0);
          const position = grokReplacement(text, lineOffset, lineOffset + oldString.length);
          const detail = {
            old_string: oldString,
            old_line: range.start + 1,
            new_string: newString,
            new_line: range.start + 1 + shift,
            context_before: "",
            context_after: position.contextAfter,
            line_prefix: "",
          };
          newLines.splice(range.start + shift, range.end - range.start, ...range.lines);
          shift += range.lines.length - (range.end - range.start);
          return detail;
        });

        const normalizer = applyFrames([{
          sessionUpdate: "tool_call_update",
          toolCallId: "call-many",
          kind: "edit",
          status: "completed",
          rawInput: { file_path: filePath, replace_all: true },
          content: [{
            type: "diff",
            path: filePath,
            oldText: "",
            newText: "",
            _meta: { details },
          }],
        }]);
        const fileDiff = activities(normalizer)[0]?.details[0]?.fileDiff;
        const changed = details.some((detail) => detail.old_string !== detail.new_string);
        if (!changed) return;
        expect(fileDiff).toBeDefined();
        expect(applyUnifiedDiff(lines, fileDiff!.diff)).toEqual(newLines);
      }),
      { numRuns: 300 },
    );
  });
});
