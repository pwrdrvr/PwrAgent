import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadEntry, AppServerThreadMessageEntry, AppServerThreadReviewEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { pageNormalizedReplay } from "../app-server/thread-replay-pagination";
import { claudeCommandActivity, groupClaudeActivities } from "../claude/claude-activity";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { ClaudeTranscriptHistory } from "../claude/claude-transcript-history";

const id = "e4444444-4444-4444-8444-444444444444";

function row(index: number, revision = "saved", turnId = `turn-${index}`): AppServerThreadMessageEntry {
  return {
    id: `entry-${index}`, type: "message", role: "assistant", text: `history-probe-${index}-${revision}`,
    turn: { id: turnId },
  };
}

async function withStores(test: (writer: ClaudeSessionStore, reader: ClaudeSessionStore, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-history-property-"));
  try {
    await test(new ClaudeSessionStore(root), new ClaudeSessionStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("reads only newly appended transcript records after another store updates a warm thread", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 32, max: 220 }),
    fc.integer({ min: 1, max: 8 }),
    async (priorEntries, newEntries) => withStores(async (writer, reader) => {
      const old = Array.from({ length: priorEntries }, (_, index) => row(index));
      await writer.append(id, old);
      expect(await reader.entries(id)).toEqual(old);
      const newer = Array.from({ length: newEntries }, (_, index) => row(priorEntries + index));
      const revision = row(0, "changed");
      await writer.append(id, [revision, ...newer]);
      let decoded = 0;
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (text.includes('"text":"history-probe-')) decoded++;
        return parse(text, reviver);
      });
      try {
        const expected = [revision, ...old.slice(1), ...newer];
        expect(await reader.entries(id)).toEqual(expected);
        expect(await reader.entries(id)).toEqual(expected);
        expect(decoded).toBe(newEntries + 1);
      } finally {
        spy.mockRestore();
      }
    }),
  ), { numRuns: 20 });
});

it("matches a cold restart through append, revision, rewind, undo and a torn final line", async () => {
  await withStores(async (writer, reader, root) => {
    const first = row(0);
    const second = row(1);
    await writer.append(id, [first, second]);
    expect(await reader.entries(id)).toEqual([first, second]);
    const truncation = await writer.truncate(id, second.id);
    expect(await reader.entries(id)).toEqual([first]);
    await writer.undoTruncation(id, truncation);
    expect(await reader.entries(id)).toEqual([first, second]);

    const file = path.join(root, `${id}.jsonl`);
    const line = JSON.stringify(row(2));
    const split = Math.floor(line.length / 2);
    await appendFile(file, line.slice(0, split));
    expect(await reader.entries(id)).toEqual([first, second]);
    await appendFile(file, line.slice(split) + "\n");
    const update = row(0, "revised");
    await writer.append(id, [update], { turnId: "turn-0", status: "completed", startedAt: 1, completedAt: 2 });
    const expected = [{ ...update, turn: { id: "turn-0", status: "completed", startedAt: 1, completedAt: 2 } }, second, row(2)];
    expect(await reader.entries(id)).toEqual(expected);
    expect(await new ClaudeSessionStore(root).entries(id)).toEqual(expected);
  });
});

it("groups adjacent tool calls with work proportional to the number of details", () => {
  fc.assert(fc.property(fc.integer({ min: 20, max: 220 }), (count) => {
    let visits = 0;
    const entries: AppServerThreadEntry[] = Array.from({ length: count }, (_, index) => {
      const activity = claudeCommandActivity({ id: `command-${index}`, command: "git status", status: "completed" });
      const detail = activity.details[0]!;
      activity.details[0] = { ...detail, get command() { visits++; return detail.command; } };
      return { ...activity, turn: { id: "one-turn" } };
    });
    const [group] = groupClaudeActivities(entries);
    expect(group).toMatchObject({ id: "command-0", summary: `Ran ${count} commands` });
    expect(group?.type === "activity" && group.details.map((detail) => detail.id))
      .toEqual(Array.from({ length: count }, (_, index) => `command-${index}`));
    expect(visits).toBeLessThanOrEqual(6 * count);
  }));
});

it("serves the same page as the full replay through re-observation and history changes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom("append", "revise", "finish", "rewind", "undo", "read"), { minLength: 8, maxLength: 25 }),
    fc.integer({ min: 0, max: 4 }),
    fc.boolean(),
    async (operations, limit, legacyUntimed) => withStores(async (writer, reader, root) => {
      await writer.save({
        thread: { id, title: "Transcript fixture", titleSource: "explicit", source: "claude", linkedDirectories: [] },
        cwd: root,
      });
      const backend = new ClaudeBackend({
        store: reader, emit: async () => undefined, request: async () => undefined, cancelRequest: async () => undefined,
      });
      const otherObserver = new ClaudeBackend({
        store: new ClaudeSessionStore(root), emit: async () => undefined,
        request: async () => undefined, cancelRequest: async () => undefined,
      });
      let next = 1;
      const seed = row(0);
      if (legacyUntimed) delete seed.turn;
      await writer.append(id, [seed]);
      let truncation: string | undefined;
      try {
        for (const operation of operations) {
          const full = await backend.readThread(id);
          expect(full).toEqual(await otherObserver.readThread(id));
          const options = { limit, backend: "claude" as const, threadId: id };
          const expected = pageNormalizedReplay(full, options);
          const actual = await backend.readThread(id, options);
          expect(actual).toEqual(expected);
          const before = expected.pagination.previousCursor;
          if (before) {
            expect(await backend.readThread(id, { limit, before }))
              .toEqual(pageNormalizedReplay(full, { ...options, before }));
          }

          const last = full.entries.at(-1);
          if (operation === "append") {
            // Include adjacent tool calls and a task whose turn interleaves
            // with subsequent turns. Each operation appends a known record.
            const index = next++;
            const turnId = `turn-${index}`;
            const calls = ["a", "b"].map((name) => ({
              ...claudeCommandActivity({ id: `tool-${index}-${name}`, command: "git status", status: "completed" }),
              turn: { id: turnId },
            }));
            await writer.append(id, [row(index), ...calls, row(next++, "follow-up", "turn-0")]);
            truncation = undefined;
          } else if (operation === "revise" && last?.type === "message") {
            await writer.append(id, [{ ...last, text: `${last.text} revised` }]);
            truncation = undefined;
          } else if (operation === "finish" && last?.turn?.id) {
            await writer.append(id, [], { turnId: last.turn.id, status: "completed", completedAt: next });
          } else if (operation === "rewind" && full.entries.length > 1 && last) {
            truncation = await writer.truncate(id, last.id);
          } else if (operation === "undo" && truncation) {
            await writer.undoTruncation(id, truncation);
            truncation = undefined;
          }
        }
      } finally {
        await backend.close();
        await otherObserver.close();
      }
    }),
  ), { numRuns: 24 });
});

it("does no transcript work for metadata reads and imports only newly settled or retryable reviews", async () => {
  await withStores(async (writer, reader, root) => {
    await writer.save({
      thread: { id, title: "Transcript fixture", titleSource: "explicit", source: "claude", linkedDirectories: [] },
      cwd: root,
    });
    await writer.append(id, [{
      id: "review", type: "review", review: "Earlier findings.",
      turn: { id: "review-turn", status: "in_progress" },
    }, row(0)]);
    const backend = new ClaudeBackend({
      store: reader, emit: async () => undefined, request: async () => undefined, cancelRequest: async () => undefined,
    });
    const read = vi.spyOn(reader, "transcript");
    const importReviews = vi.fn<(entries: AppServerThreadReviewEntry[]) => readonly string[] | void>();
    try {
      expect((await backend.readThread(id, { includeTurns: false, limit: 0, importReviews })).threadStatus).toBe("idle");
      expect(read).not.toHaveBeenCalled();
      await backend.readThread(id, { limit: 1, importReviews });
      expect(importReviews).not.toHaveBeenCalled();
      await writer.append(id, [], { turnId: "review-turn", status: "completed" });
      importReviews.mockReturnValueOnce(["review"]);
      const page = await backend.readThread(id, { limit: 1, importReviews });
      expect(page.entries.map((entry) => entry.id)).toEqual(["entry-0"]);
      expect(importReviews).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ id: "review", turn: { id: "review-turn", status: "completed" } }),
      ]);
      await backend.readThread(id, { limit: 1, importReviews });
      await backend.readThread(id, { limit: 1, importReviews });
      expect(importReviews).toHaveBeenCalledTimes(2);
    } finally {
      await backend.close();
    }
  });
});

it("bounds a warm newest-page read independently of stored turns", () => {
  fc.assert(fc.property(fc.integer({ min: 500, max: 2_000 }), fc.integer({ min: 1, max: 10 }), (size, limit) => {
    const history = new ClaudeTranscriptHistory();
    let visits = 0;
    history.apply(Array.from({ length: size }, (_, index) => new Proxy(row(index), {
      get(target, property, receiver) {
        if (property === "turn") visits++;
        return Reflect.get(target, property, receiver);
      },
    })));
    visits = 0;
    const page = history.page({ limit }, new Map());
    expect(page?.entries.map((entry) => entry.id)).toEqual(Array.from({ length: limit }, (_, index) => row(size - limit + index).id));
    expect(page?.hasOlderEntries).toBe(true);
    expect(visits).toBeLessThanOrEqual(3 * limit + 4);
  }));
});
