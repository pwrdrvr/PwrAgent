import { expect, it } from "vitest";
import fc from "fast-check";
import type {
  AppServerThreadEntry,
  AppServerThreadReplay,
} from "../contracts/normalized-app-server";
import {
  fitThreadReplayWithinByteBudget,
  replayWithEntries,
  type ThreadReplayCursorIdSpace,
} from "../thread-replay-paging";

const cursorSpaces = ["provider-cursor", "entry-id"] as const;
const noPreviousPage = { supportsPagination: true, hasPreviousPage: false };
const omitted = "Content omitted because this page exceeded the federation frame limit.";

// The shared project targets Node for tests and compiles without Node globals.
declare const Buffer: { byteLength(value: string): number };

function fixture(entries: AppServerThreadEntry[], hasPreviousPage = true): AppServerThreadReplay {
  return replayWithEntries(
    { entries: [], messages: [], pagination: noPreviousPage, agentName: 'Agent 😀"\n' },
    entries,
    hasPreviousPage
      ? { ...noPreviousPage, hasPreviousPage, previousCursor: 'opaque:/😀"\n' }
      : noPreviousPage,
  );
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function responseBytes(replay: AppServerThreadReplay | null): number {
  return jsonBytes({ backend: "synthetic", replay, fetchedAt: 123 });
}

const responseWrapperBytes = responseBytes(null) - jsonBytes(null);

function isCursorEntry(entry: AppServerThreadEntry): boolean {
  return !(entry.type === "activity" && entry.summary.startsWith("Monitor usage:"));
}

function cursorFor(entries: AppServerThreadEntry[], hasPrevious: boolean) {
  const first = hasPrevious ? entries.find(isCursorEntry) : undefined;
  return first ? { ...noPreviousPage, hasPreviousPage: true, previousCursor: first.id } : noPreviousPage;
}

function omit(entry: AppServerThreadEntry): AppServerThreadEntry {
  const { id, createdAt, turn } = entry;
  const identity = { id, ...(createdAt ? { createdAt } : {}), ...(turn ? { turn } : {}) };
  switch (entry.type) {
    case "message":
      return {
        ...identity,
        type: "message",
        role: entry.role,
        text: omitted,
        ...(entry.phase ? { phase: entry.phase } : {}),
      };
    case "activity":
      return {
        ...identity,
        type: "activity",
        summary: omitted,
        details: [],
        ...(entry.tone ? { tone: entry.tone } : {}),
        ...(entry.status ? { status: entry.status } : {}),
      };
    case "plan":
      return { ...identity, type: "plan", markdown: omitted, steps: [] };
    case "review":
      return { ...identity, type: "review", review: omitted, ...(entry.status ? { status: entry.status } : {}) };
  }
}

/** Exhaustive oracle for the original first-fit order, measured as whole JSON responses. */
function candidates(source: AppServerThreadReplay, space: ThreadReplayCursorIdSpace) {
  const { entries, pagination } = source;
  const pages = [source];
  if (space === "provider-cursor") {
    for (let count = 1; count <= entries.length; count += 1) {
      const compacted = [...entries.slice(0, count).map(omit), ...entries.slice(count)];
      pages.push(replayWithEntries(source, compacted, pagination));
    }
  } else {
    for (let start = 1; start < entries.length; start += 1) {
      const suffix = entries.slice(start);
      pages.push(replayWithEntries(source, suffix, cursorFor(suffix, true)));
    }
    const last = entries.at(-1);
    if (last) {
      const compactedCursor = cursorFor([last], pagination.hasPreviousPage || entries.length > 1);
      pages.push(replayWithEntries(source, [omit(last)], compactedCursor));
    }
  }
  return {
    pages: pages.map((replay) => ({ replay, bytes: responseBytes(replay) })),
    fallback: replayWithEntries(source, [], space === "provider-cursor" ? pagination : noPreviousPage),
  };
}

const rowKinds = ["user", "assistant", "activity", "overlay", "plan", "review"] as const;
type RowData = { kind: typeof rowKinds[number]; text: string; longId: boolean; metadata: boolean };
const rowData: fc.Arbitrary<RowData> = fc.record({
  kind: fc.constantFrom(...rowKinds),
  text: fc.constantFrom("", "ASCII", '😀é"\\\n\u0000\ud800', "wide😀".repeat(32)),
  longId: fc.boolean(),
  metadata: fc.boolean(),
});

function entryFrom(row: RowData, index: number): AppServerThreadEntry {
  const id = row.longId ? `row-${index}-${'😀"\\'.repeat(30)}` : `row-${index}`;
  const metadata = row.metadata ? { createdAt: 123, turn: { id: `turn-${index}` } } : {};
  switch (row.kind) {
    case "user":
    case "assistant":
      return {
        type: "message", id, role: row.kind, text: row.text, ...metadata,
        ...(row.metadata ? { phase: "final", parts: [{ type: "file", name: row.text }], origin: { kind: "agent" } } : {}),
      };
    case "activity":
    case "overlay":
      return {
        type: "activity", id, summary: row.kind === "overlay" ? "Monitor usage: " + row.text : row.text,
        details: [{ id: "detail", kind: "read", label: row.text }], status: "completed", ...metadata,
      };
    case "plan":
      return { type: "plan", id, markdown: row.text, steps: [{ step: row.text, status: "pending" }], ...metadata };
    case "review":
      return { type: "review", id, review: row.text, displayText: row.text, status: "completed", ...metadata };
  }
}

it("matches the first fitting page at exact UTF-8 byte boundaries for both cursor spaces", () => {
  fc.assert(fc.property(
    fc.array(rowData, { maxLength: 8, size: "max" }),
    fc.boolean(),
    fc.boolean(),
    (rows, hasPrevious, omitMessageProjections) => {
      const source = fixture(rows.map(entryFrom), hasPrevious);
      if (omitMessageProjections) {
        source.messages = [];
        source.lastUserMessage = undefined;
        source.lastAssistantMessage = undefined;
      }
      for (const cursorIdSpace of cursorSpaces) {
        const { pages, fallback } = candidates(source, cursorIdSpace);
        for (const budget of new Set([0, ...pages.flatMap(({ bytes }) => [bytes - 1, bytes, bytes + 1])])) {
          const expected = pages.find(({ bytes }) => bytes <= budget)?.replay ?? fallback;
          const actual = fitThreadReplayWithinByteBudget({
            cursorIdSpace,
            isCursorEntry,
            replay: source,
            maxBytes: budget - responseWrapperBytes,
            measureJsonBytes: jsonBytes,
          });
          expect(actual).toEqual(expected);
          if (expected === source) {
            expect(actual).toBe(source);
          }
        }
      }
    },
  ));
});

it("keeps a longer suffix that fits by minting a shorter entry cursor", () => {
  const source = fixture([
    { type: "message", id: "older", role: "user", text: "q".repeat(1024) },
    { type: "activity", id: "short", summary: "Short", details: [] },
    { type: "activity", id: "long".repeat(128), summary: "Long", details: [] },
  ]);
  const { pages } = candidates(source, "entry-id");
  const longer = pages[1]!;
  expect(pages[2]!.bytes).toBeGreaterThan(longer.bytes);
  expect(fitThreadReplayWithinByteBudget({
    cursorIdSpace: "entry-id",
    replay: source,
    maxBytes: longer.bytes - responseWrapperBytes,
    measureJsonBytes: jsonBytes,
  })).toEqual(longer.replay);
});

it("stops at the first fitting compaction when the next omission adds bytes", () => {
  const source = fixture([
    { type: "message", id: "older", role: "user", text: "q".repeat(1024) },
    { type: "message", id: "short", role: "assistant", text: "" },
    { type: "message", id: "newer", role: "assistant", text: "a".repeat(1024) },
  ]);
  const { pages } = candidates(source, "provider-cursor");
  const firstCompaction = pages[1]!;
  expect(pages[2]!.bytes).toBeGreaterThan(firstCompaction.bytes);
  expect(fitThreadReplayWithinByteBudget({
    cursorIdSpace: "provider-cursor",
    replay: source,
    maxBytes: firstCompaction.bytes - responseWrapperBytes,
    measureJsonBytes: jsonBytes,
  })).toEqual(firstCompaction.replay);
});

const workloads = cursorSpaces.flatMap((space) => [
  [space, 64, 16 * 1024, 1024 * 1024],
  [space, 128, 16 * 1024, 1024 * 1024],
  [space, 140, 64 * 1024, 16 * 1024 * 1024 - 64 * 1024],
] as const);

it.each(workloads)("bounds encoded work for %s overflow with %i entries", (cursorIdSpace, count, textBytes, budget) => {
  const source = fixture(Array.from({ length: count }, (_, index) => ({
    type: "message",
    id: `provider-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: "x".repeat(textBytes),
  })));
  const inputBytes = responseBytes(source);
  expect(inputBytes).toBeGreaterThan(budget);
  let fullEncodes = 0;
  let encodes = 0;
  let encodedBytes = 0;
  const fitted = fitThreadReplayWithinByteBudget({
    cursorIdSpace,
    replay: source,
    maxBytes: budget - responseWrapperBytes,
    measureJsonBytes: (value) => {
      const bytes = jsonBytes(value);
      encodes += 1;
      encodedBytes += bytes;
      if (typeof value === "object" && value && "entries" in value
        && Array.isArray(value.entries) && value.entries.length > 1) {
        fullEncodes += 1;
      }
      return bytes;
    },
  });
  expect(responseBytes(fitted)).toBeLessThanOrEqual(budget);
  expect(fitted.entries.length).toBeGreaterThan(1);
  expect.soft(fullEncodes).toBeLessThanOrEqual(2);
  expect.soft(encodes).toBeLessThanOrEqual(2 * count + 4);
  expect.soft(encodedBytes).toBeLessThanOrEqual(4 * inputBytes);
});
