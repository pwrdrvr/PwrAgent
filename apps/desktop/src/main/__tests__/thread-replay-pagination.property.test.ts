import { expect, it } from "vitest";
import fc from "fast-check";
import type { AppServerThreadEntry, AppServerThreadReplay } from "@pwragent/shared";
import { pageNormalizedReplay } from "../app-server/thread-replay-pagination";
import { fitNormalizedReplayWithinByteBudget } from "../app-server/thread-replay-pagination";
import {
  combineTranscriptEntries, createTranscriptHistoryIndex, prependTranscriptHistoryPage,
  type LoadedTranscriptHistory,
} from "../../renderer/src/lib/segmented-transcript";

function replay(entries: AppServerThreadEntry[]): AppServerThreadReplay {
  const messages = entries.flatMap((entry) => entry.type === "message"
    ? [{ id: entry.id, role: entry.role, text: entry.text }] : []);
  return { entries, messages, lastUserMessage: messages.findLast((entry) => entry.role === "user")?.text,
    lastAssistantMessage: messages.findLast((entry) => entry.role === "assistant")?.text,
    pagination: { supportsPagination: false, hasPreviousPage: false } };
}

function message(id: string, text: string): AppServerThreadEntry {
  return { type: "message", id, role: "user", text };
}

const turns = fc.array(fc.record({ commentary: fc.integer({ min: 0, max: 3 }), text: fc.string({ maxLength: 12 }) }), { maxLength: 12 });
type Turn = { commentary: number; text: string };
type Metadata = "all" | "none" | "partial";

function ledger(turns: Turn[], metadata: Metadata): AppServerThreadEntry[] {
  return turns.flatMap((turn, index) => Array.from({ length: turn.commentary + 2 }, (_, part): AppServerThreadEntry => ({
    type: "message", id: `provider:${index}:${part}`, role: part === 0 ? "user" : "assistant", text: turn.text,
    ...(part > 0 ? { phase: part === turn.commentary + 1 ? "final" as const : "commentary" as const } : {}),
    ...(metadata === "all" || (metadata === "partial" && index % 2 === 0)
      ? { turn: { id: `turn:${index}`, status: "completed" as const } } : {}),
  })));
}

function roundTrip(turns: Turn[], metadata: Metadata, limit: number, appendBetweenPages: boolean) {
  const original = ledger(turns, metadata);
  let source = replay(original);
  const providerIds = new Set(original.map((entry) => entry.id));
  let page = pageNormalizedReplay(source, { limit });
  const tail = page.entries;
  const index = createTranscriptHistoryIndex();
  let history: LoadedTranscriptHistory | undefined;
  const pages: AppServerThreadEntry[][] = [];
  const cursors = new Set<string>();
  for (let read = 0; ; read++) {
    expect(read).toBeLessThanOrEqual(original.length);
    pages.unshift(page.entries);
    // With complete metadata, `limit` counts complete turns, never pieces
    // of one. The original provider ledger is the independent oracle.
    if (metadata === "all") {
      for (const turnId of new Set(page.entries.map((entry) => entry.turn?.id))) {
        expect(page.entries.filter((entry) => entry.turn?.id === turnId))
          .toEqual(original.filter((entry) => entry.turn?.id === turnId));
      }
    }
    if (!page.pagination.hasPreviousPage) break;
    const before = page.pagination.previousCursor!;
    expect(providerIds.has(before)).toBe(true);
    expect(cursors.has(before)).toBe(false);
    cursors.add(before);
    if (appendBetweenPages && read === 0) {
      // A new completed turn is newer than this scan's stable `before`
      // boundary. It must neither shift nor duplicate the older pages.
      source = replay([...original,
        { ...message("new-user-item", "Newer prompt"), turn: { id: "new-turn", status: "completed" } },
        { type: "message", id: "new-assistant-item", role: "assistant", text: "Newer answer", phase: "final",
          turn: { id: "new-turn", status: "completed" } },
      ]);
    }
    page = pageNormalizedReplay(source, { before, limit });
    history = prependTranscriptHistoryPage({ history, index, tailEntries: tail,
      page: { backend: "claude", threadId: "thread", fetchedAt: 0, replay: page } });
  }
  expect(pages.flat().map((entry) => entry.id)).toEqual(original.map((entry) => entry.id));
  expect([...combineTranscriptEntries(history, index, tail)].map((entry) => entry.id)).toEqual(original.map((entry) => entry.id));
}

it("round-trips every provider entry once, in order, across positive page sizes and turn metadata", () => {
  fc.assert(fc.property(turns, fc.constantFrom<Metadata>("all", "none", "partial"),
    fc.integer({ min: 1, max: 20 }), fc.boolean(), roundTrip));
});

function overlayRoundTrip(olderBytes: number, newerTexts: string[], limit: number) {
  const provider = [message("older-provider", "x".repeat(olderBytes)), ...newerTexts.map((text, i) => message(`newer-provider:${i}`, text))];
  const overlay: AppServerThreadEntry = { type: "activity", id: "live-turn-usage-older", summary: "Turn usage: 1 in", details: [], status: "completed" };
  const entries = [provider[0]!, overlay, ...provider.slice(1)];
  const bytes = (value: AppServerThreadReplay) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const first = fitNormalizedReplayWithinByteBudget({ cursorIdSpace: "entry-id", replay: replay(entries),
    maxBytes: bytes(replay(entries.slice(1))) + 100, measureBytes: bytes });
  // This is the #1919 pipeline: the transport trims a replay after overlay
  // injection; the next read resolves its cursor in the raw provider replay.
  const ids = new Set(provider.map((entry) => entry.id));
  let page = first;
  const pages = [first.entries];
  const cursors = new Set<string>();
  while (page.pagination.hasPreviousPage) {
    const before = page.pagination.previousCursor!;
    expect(ids.has(before)).toBe(true);
    expect(cursors.has(before)).toBe(false);
    cursors.add(before);
    page = pageNormalizedReplay(replay(provider), { before, limit });
    pages.unshift(page.entries);
  }
  expect(pages.flat().filter((entry) => ids.has(entry.id)).map((entry) => entry.id)).toEqual(provider.map((entry) => entry.id));
  expect(first.entries.map((entry) => entry.id)).toContain(overlay.id);
}

it("round-trips trimmed provider history when an injected usage row leads the newest page", () => {
  fc.assert(fc.property(fc.integer({ min: 1_000, max: 4_000 }),
    fc.array(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 6 }),
    fc.integer({ min: 1, max: 10 }), overlayRoundTrip));
});

function nativeCursorRoundTrip(payloadBytes: number, count: number) {
  const source = replay(Array.from({ length: count }, (_, i) => message(`provider:${i}`, "x".repeat(payloadBytes))));
  source.pagination = { supportsPagination: true, hasPreviousPage: true, previousCursor: "opaque-provider-cursor" };
  const bytes = (value: AppServerThreadReplay) => Buffer.byteLength(JSON.stringify(value), "utf8");
  // One byte under the full page forces compaction but leaves room for every
  // entry's compacted representation. Impossible byte budgets promise no rows.
  const fitted = fitNormalizedReplayWithinByteBudget({ cursorIdSpace: "provider-cursor", replay: source,
    maxBytes: bytes(source) - 1, measureBytes: bytes });
  expect(fitted.pagination).toEqual(source.pagination);
  expect(fitted.entries.map((entry) => entry.id)).toEqual(source.entries.map((entry) => entry.id));
}

it("keeps every native-page item and its opaque continuation boundary under a feasible byte budget", () => {
  fc.assert(fc.property(fc.integer({ min: 1_000, max: 4_000 }), fc.integer({ min: 1, max: 6 }), nativeCursorRoundTrip));
});

it("retains one complete turn at page size one (shrunk #1325 regression)", () => {
  roundTrip([{ commentary: 0, text: "" }], "all", 1, false);
});

it("pages behind a leading usage row through a provider-owned cursor (shrunk #1919 regression)", () => {
  overlayRoundTrip(1_000, [""], 1);
});

it("keeps an opaque cursor while compacting one native item (shrunk #1919 regression)", () => {
  nativeCursorRoundTrip(1_000, 1);
});
