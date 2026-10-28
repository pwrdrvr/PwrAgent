import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AgentEvent,
  AppServerReadThreadResponse,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerThreadTurnMetadata,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { anchorTurnUsageEntries } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

// Seeded Claude sessions. Each seed is a random but repeatable mix of
// commentary, sequential and parallel tools that repeat one command,
// mid-turn compactions, sends from the composer and from automation, slow
// reads, and switches away from the thread and back. After the last turn the
// transcript must hold every turn's rows together, in turn order, and inside
// each turn in the order the read reports.

// Each seed failed before the fix it names:
// - 6 and 19: a re-read refilled rows across turns, so earlier turns' tools
//   and totals landed below a turn that compacted in the background.
// - 23: a row matched by content took a live row from another turn, with
//   that row's time and place.
// - 107: two runs of one command in a turn both took one live row's place.
// - 231: fails until all three are in.
const SEEDS = [6, 19, 23, 107, 231];

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function buildThread(updatedAt: number, id: string): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "explicit",
    summary: "",
    source: "claude",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt,
  };
}

/** PwrAgent's Claude store: append-only, first position wins, last value wins. */
class ClaudeStore {
  readonly lines: AppServerThreadEntry[] = [];
  active = false;

  append(entry: AppServerThreadEntry): void {
    this.lines.push(structuredClone(entry));
  }

  /** What `ClaudeBackend.readThread` plus main's turn totals return. */
  read(now: number): AppServerReadThreadResponse {
    const byId = new Map<string, AppServerThreadEntry>();
    for (const entry of this.lines) {
      byId.set(entry.id, entry);
    }
    const notice = (entry: AppServerThreadEntry | undefined) =>
      entry?.id.startsWith("notice:") === true;
    const grouped: AppServerThreadEntry[] = [];
    for (const entry of byId.values()) {
      const previous = grouped.at(-1);
      if (
        entry.type === "activity"
        && previous?.type === "activity"
        && !notice(entry)
        && !notice(previous)
        && entry.turn?.id
        && previous.turn?.id === entry.turn.id
      ) {
        grouped[grouped.length - 1] = {
          ...previous,
          details: [...previous.details, ...entry.details],
          summary: "Used tools",
          status: previous.status === "in_progress" || entry.status === "in_progress"
            ? "in_progress"
            : entry.status,
        };
        continue;
      }
      grouped.push(entry);
    }
    const completed = new Map<string, AppServerThreadTurnMetadata>();
    for (const entry of grouped) {
      if (entry.turn?.status === "completed") {
        completed.set(entry.turn.id, entry.turn);
      }
    }
    const totals: AppServerThreadEntry[] = [...completed.values()].map((turn) => ({
      type: "activity",
      id: `live-turn-usage-${turn.id}`,
      summary: `Turn usage: ${turn.id}`,
      status: "completed",
      details: [],
      createdAt: turn.completedAt,
      turn,
    }));
    const entries = anchorTurnUsageEntries([...grouped, ...totals]);
    const messages = entries
      .filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message")
      .map(({ type: _type, ...message }) => message);
    return {
      backend: "claude",
      fetchedAt: now,
      threadId: "thread-1",
      threadStatus: this.active ? "active" : "idle",
      replay: {
        entries,
        messages,
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    };
  }
}

/** Every way the transcript breaks the store's order, empty when none. */
function orderProblems(
  entries: AppServerThreadEntry[],
  read: AppServerReadThreadResponse,
): string[] {
  const problems: string[] = [];
  const finished = new Set<string>();
  let currentTurn: string | undefined;
  for (const entry of entries) {
    const turnId = entry.turn?.id;
    if (!turnId || turnId === currentTurn) {
      continue;
    }
    if (finished.has(turnId)) {
      problems.push(`${turnId} resumes after ${currentTurn ?? "?"} at ${entry.id}`);
    }
    if (currentTurn) {
      finished.add(currentTurn);
    }
    currentTurn = turnId;
  }
  const readIndex = new Map(read.replay.entries.map((entry, index) => [entry.id, index]));
  let lastIndex = -1;
  let lastId = "";
  for (const entry of entries) {
    const index = readIndex.get(entry.id);
    if (index === undefined) {
      continue;
    }
    if (index < lastIndex) {
      problems.push(`${entry.id} follows ${lastId}`);
    }
    lastIndex = index;
    lastId = entry.id;
  }
  return problems;
}

async function runSeed(seed: number): Promise<{ problems: string[]; transcript: string[] }> {
  const random = rng(seed);
  const chance = (p: number) => random() < p;
  const pick = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const store = new ClaudeStore();
  let now = 1_793_150_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let emit: (event: AgentEvent) => void = () => undefined;
  const pendingReads: Array<{ resolve: () => void; due: number }> = [];
  let step = 0;
  const readThread = vi.fn(async (params: { threadId: string }) => {
    const response = params.threadId === "thread-1"
      ? store.read(now)
      : { ...new ClaudeStore().read(now), threadId: params.threadId };
    const lag = chance(0.5) ? 0 : pick(1, 6);
    if (lag > 0) {
      await new Promise<void>((resolve) => {
        pendingReads.push({ resolve, due: step + lag });
      });
    }
    return response;
  });
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => {
      emit = listener;
      return () => undefined;
    },
    readThread,
  };
  let updatedAt = 1_000;
  let selected = "thread-1";
  const { result, rerender, unmount } = renderHook(
    ({ thread }) => useThreadSessionState({ desktopApi, thread }),
    { initialProps: { thread: buildThread(updatedAt, selected) } },
  );
  const flush = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  await waitFor(() => {
    expect(result.current.response?.threadId).toBe("thread-1");
  });
  const send = async (method: string, params: Record<string, unknown>) => {
    await act(async () => {
      emit({ backend: "claude", notification: { method, params } } as AgentEvent);
    });
  };
  const select = async (threadId: string) => {
    selected = threadId;
    updatedAt += 1_000;
    rerender({ thread: buildThread(updatedAt, selected) });
    await flush();
  };
  const tick = async () => {
    step += 1;
    now += pick(200, 4_000);
    let released = false;
    while (pendingReads.length && pendingReads[0]!.due <= step) {
      const read = pendingReads.shift()!;
      await act(async () => {
        read.resolve();
      });
      released = true;
    }
    if (released) {
      await flush();
    }
    if (chance(0.15)) {
      await select(chance(0.15) ? (selected === "thread-1" ? "thread-2" : "thread-1") : selected);
    }
  };

  const turnCount = pick(3, 5);
  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    const turnId = `turn-${turnIndex}`;
    const startedAt = now;
    const userSent = chance(0.5);
    const meta = (): AppServerThreadTurnMetadata => ({ id: turnId });
    const user: AppServerThreadEntry = {
      type: "message",
      id: `user:${turnId}`,
      role: "user",
      text: `${turnId} prompt`,
      createdAt: now,
      turn: { id: turnId, status: "in_progress", startedAt },
    };
    if (userSent && selected === "thread-1") {
      act(() => {
        result.current.addOptimisticUserMessage(`${turnId} prompt`);
      });
    }
    store.append(user);
    store.active = true;
    await send("turn/started", {
      threadId: "thread-1",
      turn: { id: turnId, status: "in_progress", startedAt },
    });
    await send("item/completed", {
      threadId: "thread-1",
      turnId,
      item: { id: user.id, type: "userMessage", text: user.text, content: [{ type: "text", text: user.text }] },
    });
    if (userSent && selected === "thread-1") {
      act(() => {
        result.current.setActiveTurnId(turnId);
      });
    }
    await tick();
    const owned: AppServerThreadEntry[] = [user];
    const message = async (id: string) => {
      const entry: AppServerThreadEntry = {
        type: "message",
        id,
        role: "assistant",
        text: `${id} text`,
        turn: meta(),
      };
      store.append(entry);
      owned.push(entry);
      await send("item/agentMessage/delta", { threadId: "thread-1", turnId, itemId: id, delta: entry.text });
      await send("item/completed", {
        threadId: "thread-1",
        turnId,
        item: { id, type: "agentMessage", text: entry.text },
      });
      await tick();
    };
    const startTool = async (id: string) => {
      const command = chance(0.6);
      const entry: AppServerThreadActivityEntry = command
        ? {
            type: "activity",
            id,
            summary: "Ran 1 command",
            status: "in_progress",
            createdAt: now,
            details: [{
              id,
              kind: "command",
              label: "git status",
              status: "in_progress",
              command: { displayCommand: "git status", rawCommand: "git status" },
            }],
            turn: meta(),
          }
        : {
            type: "activity",
            id,
            summary: "tool",
            status: "in_progress",
            createdAt: now,
            details: [{ id, kind: "read", label: "tool", markdown: "{}" }],
            turn: meta(),
          };
      store.append(entry);
      owned.push(entry);
      await send("item/started", {
        threadId: "thread-1",
        turnId,
        item: command
          ? { id, status: "in_progress", type: "commandExecution", command: "git status" }
          : { id, status: "in_progress", type: "dynamicToolCall", toolName: "tool", arguments: {} },
      });
      await tick();
      return entry;
    };
    const finishTool = async (entry: AppServerThreadActivityEntry) => {
      const command = entry.details[0]?.command !== undefined;
      store.append(command
        ? { ...entry, status: "completed", details: [{ ...entry.details[0]!, status: "completed" }] }
        : {
            ...entry,
            status: "completed",
            details: [
              entry.details[0]!,
              { id: `${entry.id}:output`, kind: "read", label: "out", markdown: "ok", status: "completed" },
            ],
          });
      await send("item/completed", {
        threadId: "thread-1",
        turnId,
        item: command
          ? { id: entry.id, status: "completed", type: "commandExecution", command: "git status", aggregatedOutput: "ok" }
          : {
              id: entry.id,
              status: "completed",
              type: "dynamicToolCall",
              toolName: "tool",
              contentItems: [{ type: "inputText", text: "ok" }],
            },
      });
      await tick();
    };

    const segments = pick(1, 4);
    const compactAt = chance(0.4) ? pick(0, segments - 1) : -1;
    for (let segment = 0; segment < segments; segment += 1) {
      await message(`${turnId}-m${segment}`);
      if (segment === compactAt) {
        const notice: AppServerThreadEntry = {
          type: "activity",
          id: `notice:${turnId}-c`,
          summary: "Compacted context",
          status: "completed",
          createdAt: now,
          details: [{ id: `notice:${turnId}-c:detail`, kind: "read", label: "summarized", status: "completed" }],
          turn: meta(),
        };
        store.append(notice);
        owned.push(notice);
        await send("thread/compacted", { threadId: "thread-1", itemId: `${turnId}-c` });
        await tick();
      }
      const tools = pick(1, 4);
      const ids = Array.from({ length: tools }, (_, tool) => `${turnId}-s${segment}-t${tool}`);
      if (tools > 1 && chance(0.4)) {
        const started: AppServerThreadActivityEntry[] = [];
        for (const id of ids) {
          started.push(await startTool(id));
        }
        for (const entry of started) {
          await finishTool(entry);
        }
      } else {
        for (const id of ids) {
          await finishTool(await startTool(id));
        }
      }
    }
    await message(`${turnId}-final`);

    const completedMeta = { id: turnId, status: "completed" as const, startedAt, completedAt: now };
    for (const entry of owned) {
      store.append({ ...entry, turn: completedMeta });
    }
    store.active = false;
    await send("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId,
      model: "claude-opus-5-5",
      tokenUsage: {
        last: {
          inputTokens: 1_000,
          cachedInputTokens: 900,
          cacheWriteInputTokens: 10,
          outputTokens: 50,
          reasoningOutputTokens: 5,
          totalTokens: 1_050,
        },
        claudeCostUSD: 0.5,
        model: "claude-opus-5-5",
      },
    });
    await send("turn/completed", {
      threadId: "thread-1",
      turnId,
      turn: { id: turnId, status: "completed", startedAt, output: [] },
    });
    await tick();
    now += pick(10_000, 600_000);
    for (let idle = pick(0, 3); idle > 0; idle -= 1) {
      await tick();
    }
  }
  while (pendingReads.length) {
    const read = pendingReads.shift()!;
    await act(async () => {
      read.resolve();
    });
    await flush();
  }
  await select("thread-1");

  const entries = result.current.entries;
  const problems = orderProblems(entries, store.read(now));
  const transcript = entries.map((entry) => `${entry.turn?.id ?? "-"}:${entry.id}`);
  unmount();
  return { problems, transcript };
}

describe("Claude transcript order across seeded sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(SEEDS)("keeps every turn together and in order (seed %i)", async (seed) => {
    const { problems, transcript } = await runSeed(seed);
    expect(problems, transcript.join("\n")).toEqual([]);
  });
});
