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
        ...(entry.origin?.systemReason === "thread-correspondence" ? {
          origin: { kind: "pwragent", systemReason: "thread-correspondence" },
        } : {}),
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
    const anchor = entries.findLast(isCursorEntry);
    for (let start = 1; start < entries.length; start += 1) {
      const suffix = entries.slice(start);
      if (anchor && !suffix.includes(anchor)) continue;
      pages.push(replayWithEntries(source, suffix, cursorFor(suffix, true)));
    }
    const finalEntry = entries.at(-1);
    const anchorIndex = anchor ? entries.indexOf(anchor) : -1;
    const hasPrevious = pagination.hasPreviousPage || (anchor ? anchorIndex > 0 : entries.length > 1);
    if (anchor && finalEntry !== anchor) {
      const suffix = entries.slice(anchorIndex);
      const cursor = cursorFor([anchor], hasPrevious);
      for (let count = 1; count <= suffix.length; count += 1) {
        const compacted = [...suffix.slice(0, count).map(omit), ...suffix.slice(count)];
        pages.push(replayWithEntries(source, compacted, cursor));
      }
      pages.push(replayWithEntries(source, [anchor], cursor));
      pages.push(replayWithEntries(source, [omit(anchor)], cursor));
      for (let start = anchorIndex + 1; start < entries.length; start += 1) {
        const overlays = entries.slice(start);
        pages.push(replayWithEntries(source, overlays, cursorFor(overlays, true)));
      }
    }
    const last = finalEntry;
    if (last) {
      const compactedCursor = cursorFor([last], hasPrevious);
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

it("keeps a provider cursor when the only fitting suffix is idle correspondence", () => {
  const older: AppServerThreadEntry = { type: "message", id: "older", role: "assistant", text: "Older work" };
  const anchor: AppServerThreadEntry = { type: "message", id: "anchor", role: "assistant", text: "x".repeat(240) };
  const receipt: AppServerThreadEntry = { type: "message", id: "correspondence:receipt", role: "assistant",
    text: "r".repeat(240), origin: { kind: "pwragent", systemReason: "thread-correspondence", correspondenceRevision: 2 } };
  const source = fixture([older, anchor, receipt]);
  const continuation = replayWithEntries(source, [anchor], cursorFor([anchor], true));
  const result = fitThreadReplayWithinByteBudget({
    replay: source, maxBytes: jsonBytes(continuation), cursorIdSpace: "entry-id",
    isCursorEntry: ({ id }) => id !== receipt.id, measureJsonBytes: jsonBytes,
  });
  expect(result.pagination).toEqual(continuation.pagination);
  expect(result.entries.some(({ id }) => id === anchor.id)).toBe(true);
  expect(result.entries.find(({ id }) => id === receipt.id)).toMatchObject({
    text: omitted, origin: { systemReason: "thread-correspondence" },
  });
  expect(jsonBytes(result)).toBeLessThanOrEqual(jsonBytes(continuation));
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

it.each([0, 1, 2])("bounds encodes of a dominant command at native page index %i", (commandIndex) => {
  const output = "verbose command output\n".repeat(512);
  const source = fixture(Array.from({ length: 4 }, (_, index) => ({
    type: "activity",
    id: `provider-${index}`,
    summary: index === commandIndex ? "Ran command" : "Read file",
    details: index === commandIndex ? [{
      id: "command",
      kind: "command",
      label: "List fixture rows",
      command: { displayCommand: "list-rows", output },
    }] : [],
  })));
  const budget = 4 * 1024;
  const { pages } = candidates(source, "provider-cursor");
  const firstFit = pages.findIndex(({ bytes }) => bytes <= budget);
  expect(firstFit).toBe(commandIndex + 1);

  const encodedOutput = JSON.stringify(output);
  let outputEncodes = 0;
  const fitted = fitThreadReplayWithinByteBudget({
    cursorIdSpace: "provider-cursor",
    replay: source,
    maxBytes: budget - responseWrapperBytes,
    measureJsonBytes: (value) => {
      const json = JSON.stringify(value);
      if (json.includes(encodedOutput)) {
        outputEncodes += 1;
      }
      return Buffer.byteLength(json);
    },
  });
  expect(fitted).toEqual(pages[firstFit]!.replay);
  expect(outputEncodes).toBeLessThanOrEqual(commandIndex === 0 ? 1 : 2);
});

const workloads = cursorSpaces.flatMap((space) => [
  [space, 64, 512, 32 * 1024],
  [space, 128, 512, 32 * 1024],
  [space, 140, 512, 128 * 1024],
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
  expect.soft(fullEncodes).toBeLessThanOrEqual(1);
  expect.soft(encodes).toBeLessThanOrEqual(2 * count + 4);
  expect.soft(encodedBytes).toBeLessThanOrEqual(4 * inputBytes);
});
