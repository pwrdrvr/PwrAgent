import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { applySubAgentActivityChanges } from "@pwragent/shared/sub-agent-activity-lines";
import {
  CodexNativeSubAgentActivityTracker,
  codexNativeSubAgentActivityText,
} from "../app-server/codex-native-subagent-activity";

/**
 * Rules, from what the operator sees under a working Codex worker:
 *
 * - A running worker's line is the latest step it started in its current
 *   turn. Messages and reasoning are not steps and leave the line alone.
 * - A worker whose turn ended, or that went idle, shows no line; a new turn
 *   shows none until its first step.
 * - Lines belong to the worker's parent. A parent's own steps, and a thread
 *   with no known parent, publish nothing.
 * - Each event names only what changed: one step costs one line.
 *
 * The oracle replays the same stream from those rules alone; a window that
 * merges every published change must hold exactly the oracle's lines.
 */

type Step =
  | { type: "item"; thread: number; item: "command" | "read" | "message" | "reasoning"; n: number }
  | { type: "turn"; thread: number; edge: "started" | "completed" | "failed" | "cancelled" }
  | { type: "status"; thread: number; status: "active" | "idle" | "systemError" };

const PARENTS = ["parent-a", "parent-b"];
// Workers 0-2 belong to parent-a, 3-4 to parent-b; thread 5 is parent-a itself; 6 has no parent.
const threadId = (thread: number) => thread === 5 ? "parent-a" : thread === 6 ? "stranger" : `worker-${thread}`;
const parentOf = (worker: string) => {
  const index = Number(worker.replace("worker-", ""));
  if (!worker.startsWith("worker-")) return undefined;
  return index < 3 ? "parent-a" : "parent-b";
};

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ type: fc.constant("item" as const), thread: fc.nat({ max: 6 }),
    item: fc.constantFrom("command" as const, "read" as const, "message" as const, "reasoning" as const), n: fc.nat({ max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("turn" as const), thread: fc.nat({ max: 6 }),
    edge: fc.constantFrom("started" as const, "completed" as const, "failed" as const, "cancelled" as const) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("status" as const), thread: fc.nat({ max: 6 }),
    status: fc.constantFrom("active" as const, "idle" as const, "systemError" as const) }) },
);

function notification(entry: Step): AppServerNotification {
  const id = threadId(entry.thread);
  if (entry.type === "turn") {
    return { method: `turn/${entry.edge}`, params: { threadId: id, turn: { id: "turn" } } } as unknown as AppServerNotification;
  }
  if (entry.type === "status") {
    return { method: "thread/status/changed", params: { threadId: id, status: { type: entry.status } } } as unknown as AppServerNotification;
  }
  const item = entry.item === "command"
    ? { type: "commandExecution", command: `/bin/zsh -lc 'ls -la ${entry.n}'`, commandActions: [{ type: "listFiles", command: `ls -la ${entry.n}` }] }
    : entry.item === "read"
      ? { type: "commandExecution", command: `/bin/zsh -lc 'cat f${entry.n}.txt'`, commandActions: [{ type: "read", command: `cat f${entry.n}.txt`, name: `f${entry.n}.txt` }] }
      : { type: entry.item === "message" ? "agentMessage" : "reasoning" };
  return { method: "item/started", params: { threadId: id, turnId: "turn", item: { id: `item-${entry.n}`, ...item } } } as unknown as AppServerNotification;
}

const expectedLine = (entry: Extract<Step, { type: "item" }>) =>
  entry.item === "command" ? `Running ls -la ${entry.n}` : entry.item === "read" ? `Reading f${entry.n}.txt` : undefined;

describe("Codex native worker activity lines", () => {
  it("keep each running worker's latest step, one changed line per event", () => {
    fc.assert(fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
      const tracker = new CodexNativeSubAgentActivityTracker();
      const oracle = new Map<string, string>();
      const windows = new Map<string, ReadonlyMap<string, string>>(PARENTS.map((parent) => [parent, new Map()]));
      for (const entry of steps) {
        const update = tracker.observe(notification(entry), parentOf);
        const worker = threadId(entry.thread);
        if (parentOf(worker)) {
          if (entry.type === "item") {
            const line = expectedLine(entry);
            if (line) oracle.set(worker, line);
          } else if (entry.type === "turn" || entry.status !== "active") {
            oracle.delete(worker);
          }
        }
        if (update) {
          // Only the worker that moved is named.
          expect(update.changes.activities.length + (update.changes.cleared?.length ?? 0)).toBe(1);
          windows.set(update.parentThreadId, applySubAgentActivityChanges(windows.get(update.parentThreadId)!, update.changes));
        }
        for (const parent of PARENTS) {
          const expected = new Map([...oracle].filter(([worker]) => parentOf(worker) === parent)
            .map(([worker, line]) => [`codex-native:${worker}`, line]));
          expect(new Map(windows.get(parent))).toEqual(expected);
        }
      }
    }));
  });

  it("names the command a worker wrote, not Codex's shell wrapper (codex-cli 0.169.0 capture)", () => {
    // Frames from a captured worker turn: `ls -la`, `pwd`, then reading notes.txt.
    expect(codexNativeSubAgentActivityText({ type: "commandExecution", command: "/bin/zsh -lc 'ls -la'",
      commandActions: [{ type: "listFiles", command: "ls -la", path: null }] })).toBe("Running ls -la");
    expect(codexNativeSubAgentActivityText({ type: "commandExecution", command: "/bin/zsh -lc pwd",
      commandActions: [{ type: "unknown", command: "pwd" }] })).toBe("Running pwd");
    expect(codexNativeSubAgentActivityText({ type: "commandExecution", command: "/bin/zsh -lc 'cat notes.txt'",
      commandActions: [{ type: "read", command: "cat notes.txt", name: "notes.txt", path: "/work/notes.txt" }] }))
      .toBe("Reading notes.txt");
    expect(codexNativeSubAgentActivityText({ type: "agentMessage", text: "Done" })).toBeUndefined();
  });
});

/** Counts every entry any iteration of this map yields. */
class CountingMap<K, V> extends Map<K, V> {
  visits = 0;
  override *[Symbol.iterator](): MapIterator<[K, V]> { for (const entry of super.entries()) { this.visits += 1; yield entry; } }
  override *entries(): MapIterator<[K, V]> { for (const entry of super.entries()) { this.visits += 1; yield entry; } }
  override *values(): MapIterator<V> { for (const value of super.values()) { this.visits += 1; yield value; } }
  override *keys(): MapIterator<K> { for (const key of super.keys()) { this.visits += 1; yield key; } }
}

describe("Codex native worker activity work", () => {
  it("costs one worker's line per step, however many workers run", () => {
    // 8 parents x 10 workers x 20 steps visited 249,680 lines before: every
    // step diffed every running worker's line, across every parent.
    const tracker = new CodexNativeSubAgentActivityTracker();
    const lines = new CountingMap<string, unknown>();
    Object.assign(tracker, { lines });
    for (let step = 0; step < 20; step += 1) {
      for (let worker = 0; worker < 80; worker += 1) {
        tracker.observe({ method: "item/started", params: { threadId: `worker-${worker}`, item: {
          type: "commandExecution", command: `ls ${step}`, commandActions: [{ type: "listFiles", command: `ls ${step}` }],
        } } } as unknown as AppServerNotification, (id) => `parent-${Number(id.replace("worker-", "")) % 8}`);
      }
    }
    expect(lines.size).toBe(80);
    expect(lines.visits).toBe(0);
  });
});
