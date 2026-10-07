import { describe, expect, it } from "vitest";
import type { AppLogEntry } from "../../../../../shared/app-metadata";
import {
  MAX_RENDERED_LOG_ENTRIES,
  appendRenderedLogEntry,
  buildLogCopyText,
  buildLogDisplayRows,
  createRenderedLogEntryBuffer,
  extractTypedLogSearchToken,
  highlightLogLineParts,
  logEntryMatchesSearch,
  logGapKey,
  LONG_LINE_PREVIEW_CHARS,
  orderedRenderedLogEntries,
  previewLogLineParts,
  selectedLogEntries,
  tokenizeLogLine,
  type LogDisplayRow,
} from "../log-view-model";

const THREAD = "7f3c2a10-4b1e-4d7a-9e55-0c2b8a61f9d4";

function entry(sequence: number, level: string, scope: string, message: string): AppLogEntry {
  return {
    sequence,
    timestamp: 0,
    level,
    line: `[2026-10-07 12:40:${String(sequence % 60).padStart(2, "0")}.000] [${level}] (pwragent:${scope}) ${message}`,
  };
}

function describeRows(rows: LogDisplayRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "gap") return `gap:${row.hiddenCount}`;
    if (row.kind === "mark") return "mark";
    return `${row.entry.sequence}${row.match ? "*" : ""}${row.context ? "~" : ""}`;
  });
}

const ENTRIES = [
  entry(1, "info", "backend-registry", `startThread threadId=${THREAD}`),
  entry(2, "error", "codex-client", `MCP server startup failed serverName=a threadId=${THREAD}`),
  entry(3, "error", "codex-transport", "app-server stderr line=child exited"),
  entry(4, "error", "codex-client", `MCP server startup failed serverName=b threadId=${THREAD}`),
  entry(5, "info", "backend-registry", "settings observed"),
  entry(6, "info", "app-server", "pr status transition"),
  entry(7, "info", "app-server", "pr status transition"),
  entry(8, "warn", "codex-client", "helper thread retained"),
];

describe("tokenizeLogLine", () => {
  it("classifies timestamps, levels and scopes, and makes scopes and thread IDs tokens", () => {
    expect(
      tokenizeLogLine(
        `[2026-05-12 20:06:28.722] [error] (pwragent:codex-client) failed threadId=${THREAD} again`,
      ),
    ).toEqual({
      level: "error",
      scope: "codex-client",
      parts: [
        { text: "[2026-05-12 20:06:28.722]", tone: "timestamp" },
        { text: " " },
        { text: "[error]", tone: "level-error" },
        { text: " " },
        {
          text: "(pwragent:codex-client)",
          tone: "scope",
          token: { kind: "scope", value: "codex-client" },
        },
        { text: " " },
        { text: "failed threadId=" },
        { text: THREAD, token: { kind: "thread", value: THREAD } },
        { text: " again" },
      ],
    });
  });

  it("keeps an unstructured line as one part", () => {
    expect(tokenizeLogLine("plain text")).toEqual({ parts: [{ text: "plain text" }] });
  });
});

describe("highlightLogLineParts", () => {
  it("marks case-insensitive matches inside each part and keeps its tone", () => {
    const { parts } = tokenizeLogLine(
      "[2026-05-12 20:06:28.644] [warn] (pwragent:settings) obsolete setting",
    );
    const highlighted = highlightLogLineParts(parts, "SETTING");

    expect(highlighted).toContainEqual({
      text: "setting",
      tone: "scope",
      token: { kind: "scope", value: "settings" },
      match: true,
    });
    expect(highlighted.filter((part) => part.match)).toHaveLength(2);
  });
});

describe("rendered log entry buffer", () => {
  it("keeps the newest ordered tail without shifting entries on append", () => {
    const buffer = createRenderedLogEntryBuffer();
    let droppedEntry = false;

    for (let index = 1; index <= MAX_RENDERED_LOG_ENTRIES + 2; index += 1) {
      droppedEntry =
        appendRenderedLogEntry(buffer, {
          sequence: index,
          timestamp: 0,
          level: "info",
          line: `line ${index}`,
        }) || droppedEntry;
    }

    const entries = orderedRenderedLogEntries(buffer);

    expect(droppedEntry).toBe(true);
    expect(entries).toHaveLength(MAX_RENDERED_LOG_ENTRIES);
    expect(entries[0]?.sequence).toBe(3);
    expect(entries.at(-1)?.sequence).toBe(MAX_RENDERED_LOG_ENTRIES + 2);
  });

  it("trims oversized snapshots to the newest ordered tail", () => {
    const buffer = createRenderedLogEntryBuffer(
      Array.from({ length: MAX_RENDERED_LOG_ENTRIES + 2 }, (_, index) => ({
        sequence: index + 1,
        timestamp: 0,
        level: "info",
        line: `line ${index + 1}`,
      })),
    );

    const entries = orderedRenderedLogEntries(buffer);

    expect(entries).toHaveLength(MAX_RENDERED_LOG_ENTRIES);
    expect(entries[0]?.sequence).toBe(3);
  });
});

describe("search", () => {
  it("matches text, scope tokens and thread tokens together", () => {
    const search = {
      text: "startup",
      tokens: [
        { kind: "scope" as const, value: "codex-client" },
        { kind: "thread" as const, value: THREAD },
      ],
    };

    expect(ENTRIES.filter((item) => logEntryMatchesSearch(item, search)).map(
      (item) => item.sequence,
    )).toEqual([2, 4]);
  });

  it("turns a typed scope: or thread: prefix into a token once a space follows", () => {
    expect(extractTypedLogSearchToken("failed scope:pwragent:codex-client ")).toEqual({
      text: "failed ",
      token: { kind: "scope", value: "codex-client" },
    });
    expect(extractTypedLogSearchToken(`thread:${THREAD} `)).toEqual({
      text: "",
      token: { kind: "thread", value: THREAD },
    });
    expect(extractTypedLogSearchToken("scope:codex-client")).toBeUndefined();
  });
});

describe("buildLogDisplayRows", () => {
  const base = {
    entries: ENTRIES,
    mode: "filter" as const,
    contextLines: 0 as const,
    expandedGaps: new Set<string>(),
  };

  it("shows every line without search criteria", () => {
    const { rows, matchSequences } = buildLogDisplayRows({
      ...base,
      search: { text: "", tokens: [] },
    });

    expect(describeRows(rows)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(matchSequences).toEqual([]);
  });

  it("filters to matches and replaces the rest with gap rows", () => {
    const { rows, matchSequences } = buildLogDisplayRows({
      ...base,
      search: { text: "startup failed", tokens: [] },
    });

    expect(describeRows(rows)).toEqual(["gap:1", "2*", "gap:1", "4*", "gap:4"]);
    expect(matchSequences).toEqual([2, 4]);
  });

  it("keeps context lines around each match", () => {
    const { rows } = buildLogDisplayRows({
      ...base,
      contextLines: 1,
      search: { text: "startup failed", tokens: [] },
    });

    expect(describeRows(rows)).toEqual(["1~", "2*", "3~", "4*", "5~", "gap:3"]);
  });

  it("shows a gap's lines once it is expanded", () => {
    const { rows } = buildLogDisplayRows({
      ...base,
      expandedGaps: new Set([logGapKey(5)]),
      search: { text: "startup failed", tokens: [] },
    });

    expect(describeRows(rows)).toEqual([
      "gap:1", "2*", "gap:1", "4*", "5~", "6~", "7~", "8~",
    ]);
  });

  it("keeps every line in highlight mode and flags the matches", () => {
    const { rows } = buildLogDisplayRows({
      ...base,
      mode: "highlight",
      search: { text: "", tokens: [{ kind: "scope", value: "codex-client" }] },
    });

    expect(describeRows(rows)).toEqual(["1", "2*", "3", "4*", "5", "6", "7", "8*"]);
  });

  it("puts the mark after the line it was dropped on", () => {
    const { rows } = buildLogDisplayRows({
      ...base,
      search: { text: "", tokens: [] },
      mark: { afterSequence: 5, at: 0 },
    });

    expect(describeRows(rows)).toEqual(["1", "2", "3", "4", "5", "mark", "6", "7", "8"]);
  });
});

describe("selectedLogEntries", () => {
  const { rows } = buildLogDisplayRows({
    entries: ENTRIES,
    mode: "filter",
    contextLines: 0,
    expandedGaps: new Set(),
    search: { text: "", tokens: [] },
  });

  it("covers the displayed lines between anchor and focus in either direction", () => {
    expect(
      selectedLogEntries(rows, {
        anchor: 4,
        focus: 2,
        followsTail: false,
        sinceMark: false,
      }).map((item) => item.sequence),
    ).toEqual([2, 3, 4]);
  });

  it("follows new lines when the selection reaches the tail", () => {
    expect(
      selectedLogEntries(rows, {
        anchor: 6,
        focus: 6,
        followsTail: true,
        sinceMark: true,
      }).map((item) => item.sequence),
    ).toEqual([6, 7, 8]);
  });
});

describe("buildLogCopyText", () => {
  const params = {
    entries: ENTRIES.slice(1, 4),
    totalLoaded: 1204,
    levels: ["error", "warn", "info"] as const,
    search: { text: "", tokens: [] },
    mode: "filter" as const,
    contextLines: 0 as const,
  };

  it("copies the lines alone without diagnostics", () => {
    expect(buildLogCopyText({ ...params, levels: [...params.levels] })).toBe(
      ENTRIES.slice(1, 4).map((item) => item.line).join("\n"),
    );
  });

  it("starts with diagnostics, the instance, the range and the search", () => {
    const text = buildLogCopyText({
      ...params,
      levels: [...params.levels],
      search: { text: "failed", tokens: [{ kind: "scope", value: "codex-client" }] },
      contextLines: 1,
      diagnostics: "Collected at (UTC): now\nPwrAgent version: 1.14.2",
      instanceReference: "[@studio-mac](pwragent://instance/inst-1)",
    });

    expect(text).toBe(
      [
        "Collected at (UTC): now",
        "PwrAgent version: 1.14.2",
        "PwrAgent instance: [@studio-mac](pwragent://instance/inst-1)",
        "Log lines: 2–4 (3 of 1,204 loaded; levels: Error, Warning, Info)",
        "Log search: \"failed\" scope:codex-client (filter, context ±1)",
        "",
        ...ENTRIES.slice(1, 4).map((item) => item.line),
      ].join("\n"),
    );
  });
});

describe("previewLogLineParts", () => {
  const longLine = `[2026-10-07 15:29:42.275] [info ] (pwragent:main) renderer globals keys=[${"a".repeat(1200)},listMcpConnections,${"b".repeat(400)}]`;
  const { parts } = tokenizeLogLine(longLine);
  const join = (items: { text: string }[]) => items.map((part) => part.text).join("");

  it("leaves a short line whole", () => {
    const short = tokenizeLogLine("[2026-10-07 15:29:42.275] [info ] (pwragent:main) short");
    expect(previewLogLineParts(short.parts, "x".repeat(10), "")).toEqual({
      parts: short.parts,
      hiddenChars: 0,
    });
  });

  it("cuts a long line to the preview length and keeps the tones", () => {
    const preview = previewLogLineParts(parts, longLine, "");

    expect(join(preview.parts)).toBe(longLine.slice(0, LONG_LINE_PREVIEW_CHARS));
    expect(preview.hiddenChars).toBe(longLine.length - LONG_LINE_PREVIEW_CHARS);
    expect(preview.parts[0]).toEqual({ text: "[2026-10-07 15:29:42.275]", tone: "timestamp" });
  });

  it("reaches past the first search match", () => {
    const preview = previewLogLineParts(parts, longLine, "LISTMCP");
    const shown = join(preview.parts);

    expect(shown).toContain("listMcpConnections");
    expect(shown.length + preview.hiddenChars).toBe(longLine.length);
  });

  it("shows the whole line when the cut would hide only a little", () => {
    const line = "x".repeat(LONG_LINE_PREVIEW_CHARS + 40);
    expect(previewLogLineParts([{ text: line }], line, "").hiddenChars).toBe(0);
  });
});
