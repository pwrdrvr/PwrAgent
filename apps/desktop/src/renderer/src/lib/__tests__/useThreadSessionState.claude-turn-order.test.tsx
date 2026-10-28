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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

// The shape of a Claude thread as PwrAgent's Claude backend produces it:
// - every streamed row is appended to the backend's own store, and a read
//   returns the store with consecutive tool rows of a turn folded into one
//   row named after its first tool (`groupClaudeActivities`);
// - assistant messages carry no `createdAt`;
// - `turn/completed` reports `startedAt` but no `completedAt`;
// - main adds each completed turn's total ("Turn usage:") after its turn.

type Turn = { id: string; startedAt: number; completedAt?: number };

function buildThread(updatedAt: number, id = "thread-1"): NavigationThreadSummary {
  return {
    id,
    title: "Thread",
    titleSource: "explicit",
    summary: "",
    source: "claude",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt,
  };
}

class ClaudeThreadSimulation {
  private readonly store = new Map<string, AppServerThreadEntry>();
  private readonly turns: Turn[] = [];
  now = 1_793_150_000_000;
  emit: (event: AgentEvent) => void = () => undefined;

  private send(method: string, params: Record<string, unknown>): void {
    this.emit({ backend: "claude", notification: { method, params } } as AgentEvent);
  }

  private turnMeta(turn: Turn): AppServerThreadTurnMetadata {
    return turn.completedAt === undefined
      ? { id: turn.id }
      : { id: turn.id, status: "completed", startedAt: turn.startedAt, completedAt: turn.completedAt };
  }

  startTurn(turnId: string, prompt: string): void {
    const turn: Turn = { id: turnId, startedAt: this.now };
    this.turns.push(turn);
    this.store.set(`user:${turnId}`, {
      type: "message", id: `user:${turnId}`, role: "user", text: prompt, createdAt: this.now, turn: { id: turnId },
    });
    this.send("turn/started", {
      threadId: "thread-1", turn: { id: turnId, status: "in_progress", startedAt: turn.startedAt },
    });
  }

  message(turnId: string, id: string, text: string): void {
    this.now += 1_000;
    this.store.set(id, { type: "message", id, role: "assistant", text, turn: { id: turnId } });
    this.send("item/agentMessage/delta", { threadId: "thread-1", turnId, itemId: id, delta: text });
    this.send("item/completed", { threadId: "thread-1", turnId, item: { id, type: "agentMessage", text } });
  }

  startTool(turnId: string, id: string): void {
    this.now += 1_000;
    const command = `echo ${id}`;
    this.store.set(id, {
      type: "activity", id, summary: "Ran 1 command", status: "in_progress", createdAt: this.now,
      details: [{ id, kind: "command", label: command, status: "in_progress" }], turn: { id: turnId },
    });
    this.send("item/started", {
      threadId: "thread-1", turnId, item: { id, status: "in_progress", type: "commandExecution", command },
    });
  }

  finishTool(turnId: string, id: string): void {
    this.now += 1_000;
    const command = `echo ${id}`;
    const entry = this.store.get(id) as AppServerThreadActivityEntry;
    this.store.set(id, { ...entry, status: "completed", details: [{ ...entry.details[0]!, status: "completed" }] });
    this.send("item/completed", {
      threadId: "thread-1", turnId,
      item: { id, status: "completed", type: "commandExecution", command, aggregatedOutput: "ok" },
    });
  }

  /** Claude compacts inside a turn: a notice row, then `thread/compacted`. */
  compact(turnId: string): void {
    this.now += 1_000;
    const id = `notice:${turnId}-compaction`;
    this.store.set(id, {
      type: "activity", id, summary: "Compacted context", status: "completed", createdAt: this.now,
      details: [{ id: `${id}:detail`, kind: "read", label: "1,000 tokens summarized", status: "completed" }],
      turn: { id: turnId },
    });
    this.send("thread/compacted", { threadId: "thread-1", itemId: `${turnId}-compaction` });
  }

  completeTurn(turnId: string): void {
    this.now += 1_000;
    const turn = this.turns.find((candidate) => candidate.id === turnId)!;
    turn.completedAt = this.now;
    this.send("thread/tokenUsage/updated", {
      threadId: "thread-1", turnId, model: "claude-opus-5-5",
      tokenUsage: {
        last: { inputTokens: 1_000, cachedInputTokens: 900, cacheWriteInputTokens: 10, outputTokens: 50, reasoningOutputTokens: 5, totalTokens: 1_050 },
        claudeCostUSD: 0.5,
        model: "claude-opus-5-5",
      },
    });
    this.send("turn/completed", {
      threadId: "thread-1", turnId,
      turn: { id: turnId, status: "completed", startedAt: turn.startedAt, output: [] },
    });
    this.now += 60_000;
  }

  /** What `ClaudeBackend.readThread` plus main's usage rows return. */
  read(): AppServerReadThreadResponse {
    const grouped: AppServerThreadEntry[] = [];
    for (const raw of this.store.values()) {
      const turn = this.turns.find((candidate) => candidate.id === raw.turn?.id)!;
      const entry = { ...raw, turn: this.turnMeta(turn) } as AppServerThreadEntry;
      const previous = grouped.at(-1);
      const notice = (candidate: AppServerThreadEntry | undefined) => candidate?.id.startsWith("notice:") === true;
      if (
        entry.type === "activity" && previous?.type === "activity" && previous.turn?.id === entry.turn?.id
        && !notice(entry) && !notice(previous)
      ) {
        const details = [...previous.details, ...entry.details];
        grouped[grouped.length - 1] = {
          ...previous, details, summary: `Ran ${details.length} commands`,
          status: previous.status === "in_progress" || entry.status === "in_progress" ? "in_progress" : "completed",
        };
        continue;
      }
      grouped.push(entry);
    }
    const entries: AppServerThreadEntry[] = [];
    for (const [index, entry] of grouped.entries()) {
      entries.push(entry);
      const turnId = entry.turn?.id;
      const next = grouped[index + 1];
      const turn = this.turns.find((candidate) => candidate.id === turnId);
      if (turn?.completedAt !== undefined && next?.turn?.id !== turnId) {
        entries.push({
          type: "activity",
          id: `live-turn-usage-${turn.id}`,
          summary: `Turn usage: ${turn.id}`,
          status: "completed",
          details: [],
          createdAt: turn.completedAt,
          turn: this.turnMeta(turn),
        });
      }
    }
    const messages = entries
      .filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message")
      .map(({ type: _type, ...message }) => message);
    const active = this.turns.some((turn) => turn.completedAt === undefined);
    return {
      backend: "claude",
      fetchedAt: this.now,
      threadId: "thread-1",
      threadStatus: active ? "active" : "idle",
      replay: { entries, messages, pagination: { supportsPagination: false, hasPreviousPage: false } },
    };
  }
}

/** The transcript as turn ids in display order, one per run of a turn. */
function turnRuns(entries: AppServerThreadEntry[]): string[] {
  const runs: string[] = [];
  for (const entry of entries) {
    const turnId = entry.turn?.id ?? "?";
    if (runs.at(-1) !== turnId) {
      runs.push(turnId);
    }
  }
  return runs;
}

describe("Claude turn order", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { label: "compaction in the later turn", compactLater: true },
    { label: "no compaction in the later turn", compactLater: false },
  ])("keeps earlier turns above a turn that ran in the background ($label)", async ({ compactLater }) => {
    const sim = new ClaudeThreadSimulation();
    vi.spyOn(Date, "now").mockImplementation(() => sim.now);
    const readThread = vi.fn(async (params: { threadId: string }) =>
      params.threadId === "thread-1"
        ? sim.read()
        : {
            ...sim.read(),
            threadId: params.threadId,
            replay: {
              entries: [],
              messages: [],
              pagination: { supportsPagination: false, hasPreviousPage: false },
            },
          });
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        sim.emit = listener;
        return () => undefined;
      },
      readThread,
    };
    let updatedAt = 1_000;
    const { result, rerender } = renderHook(
      ({ thread }) => useThreadSessionState({ desktopApi, thread }),
      { initialProps: { thread: buildThread(updatedAt) } },
    );
    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-1");
    });
    const settle = async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    };
    const select = async (id: string) => {
      updatedAt += 1_000;
      rerender({ thread: buildThread(updatedAt, id) });
      await settle();
    };
    const step = async (fn: () => void) => {
      act(fn);
      await settle();
    };

    // Turn 0 starts while the thread is open and compacts. The re-read after
    // the compaction lands, two tools start, and the operator leaves. Turn 0's
    // live rows stay behind: only a read of this thread prunes them.
    await step(() => sim.startTurn("turn-0", "t0 prompt"));
    await step(() => sim.message("turn-0", "t0-c1", "t0 first commentary"));
    await step(() => sim.compact("turn-0"));
    await step(() => sim.startTool("turn-0", "t0-a"));
    await step(() => sim.startTool("turn-0", "t0-b"));
    await step(() => sim.finishTool("turn-0", "t0-a"));
    await select("thread-2");
    await step(() => sim.finishTool("turn-0", "t0-b"));
    await step(() => sim.message("turn-0", "t0-final", "t0 answer"));
    await step(() => sim.completeTurn("turn-0"));
    for (const [turnId, label] of [["turn-1", "t1"], ["turn-2", "t2"]] as const) {
      await step(() => sim.startTurn(turnId, `${label} prompt`));
      await step(() => sim.message(turnId, `${label}-c1`, `${label} first commentary`));
      // A compaction drops the loaded transcript. Turn 2's answer then lands
      // in an empty one, and the live ledger lists it before turns 0 and 1.
      if (turnId === "turn-2" && compactLater) {
        await step(() => sim.compact(turnId));
      }
      await step(() => sim.startTool(turnId, `${label}-a`));
      await step(() => sim.finishTool(turnId, `${label}-a`));
      await step(() => sim.message(turnId, `${label}-c2`, `${label} second commentary`));
      await step(() => sim.startTool(turnId, `${label}-b`));
      await step(() => sim.finishTool(turnId, `${label}-b`));
      await step(() => sim.message(turnId, `${label}-final`, `${label} answer`));
      if (turnId === "turn-1") {
        await step(() => sim.completeTurn(turnId));
      }
    }
    // Back on the thread after turn 2's answer, before turn 2 completes.
    await select("thread-1");
    await step(() => sim.completeTurn("turn-2"));
    await select("thread-1");

    // The read lists every turn in order. Refilling its rows from the live
    // ledger moved turns 0 and 1's tools and totals below turn 2.
    const ids = result.current.entries.map((entry) => `${entry.turn?.id ?? "?"}:${entry.id}`);
    expect(turnRuns(result.current.entries), ids.join("\n")).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
    ]);
  });
});
