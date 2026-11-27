import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX } from "@pwragent/shared/subagent-kind";
import {
  CLAUDE_SUB_AGENT_ACTIVITY_MAX_LENGTH,
  ClaudeTaskTracker,
  claudeSubAgentActivityText,
  claudeTaskRow,
} from "../claude/claude-tasks";

/**
 * Rules, from what the operator sees:
 *
 * - A sub-agent Claude starts (the Agent tool, `local_agent`) is a sub-agent,
 *   not a command. It never appears in the Actions panel's rows.
 * - Each sub-agent has exactly one card. The card runs until Claude settles
 *   the task, or until the live background set that named it drops it, and
 *   then never runs again.
 * - Commands keep their Actions rows.
 * - Waiting For lists every running task, sub-agents included: Claude takes
 *   another turn when any of them ends.
 * - A card keeps the name its Agent call gave it. Progress reports what the
 *   worker is doing now, so it never renames the card.
 * - A running card's activity is its latest progress line; a card that no
 *   longer runs has none.
 *
 * The model is the event stream itself: each task's lifecycle as Claude
 * reports it, with notifications that race task_updated, redelivered starts
 * and notifications, and a live set that lags a settlement. Whether a task
 * runs follows the CLI's documented rule, not the tracker: once the live
 * background set has been seen, a background task runs only while the set
 * names it, and a foreground task is never in the set.
 */

type TaskKind = "agent" | "bash";
type Terminal = "completed" | "failed" | "stopped";

type TaskPlan = {
  kind: TaskKind;
  backgrounded: boolean;
  /** How the task ends, if it ends inside the stream. */
  end: "notification" | "updated-then-notification" | "dropped-from-set" | "none";
  status: Terminal;
  progress: number;
  /** Claude sends the settling notification twice. */
  duplicateEnd: boolean;
};

type Step =
  | { type: "start"; task: number; redelivery: boolean }
  | { type: "progress"; task: number; n: number }
  | { type: "updated"; task: number; status: Terminal }
  | { type: "notification"; task: number; status: Terminal }
  | { type: "set"; lagging: number[]; dropping: number[] };

const taskPlan = fc.record<TaskPlan>({
  kind: fc.constantFrom<TaskKind>("agent", "bash"),
  backgrounded: fc.boolean(),
  end: fc.constantFrom("notification", "updated-then-notification", "dropped-from-set", "none"),
  status: fc.constantFrom<Terminal>("completed", "failed", "stopped"),
  progress: fc.nat({ max: 2 }),
  duplicateEnd: fc.boolean(),
});

/**
 * Interleaves each task's lifecycle in the order Claude can produce it. A
 * live-set snapshot can follow any step; it names every running background
 * task, may still name one that just settled (it leaves after its
 * notification), and drops a task only to end it.
 */
const scenario = fc.array(taskPlan, { minLength: 1, maxLength: 5 }).chain((plans) => {
  const lanes = plans.map((plan, task) => {
    const steps: Step[] = [{ type: "start", task, redelivery: false }];
    for (let i = 0; i < plan.progress; i += 1) steps.push({ type: "progress", task, n: i });
    if (plan.end === "updated-then-notification") {
      steps.push({ type: "updated", task, status: plan.status });
      steps.push({ type: "notification", task, status: plan.status });
    } else if (plan.end === "notification") {
      steps.push({ type: "notification", task, status: plan.status });
    }
    if (plan.duplicateEnd && (plan.end === "notification" || plan.end === "updated-then-notification")) {
      steps.push({ type: "notification", task, status: plan.status });
    }
    return steps;
  });
  const total = lanes.reduce((sum, lane) => sum + lane.length, 0);
  return fc.tuple(
    fc.constant(plans),
    fc.shuffledSubarray(lanes.flatMap((lane, task) => lane.map((_, i) => ({ task, i }))), {
      minLength: total, maxLength: total,
    }),
    fc.array(fc.boolean(), { minLength: total, maxLength: total }),
    fc.array(fc.boolean(), { minLength: total, maxLength: total }),
  ).map(([plans, order, setAfter, redeliver]) => {
    // Keep each lane in its own order; interleave lanes by the shuffle.
    const next = lanes.map(() => 0);
    const steps: Step[] = [];
    const running = new Set<number>();
    const settled = new Set<number>();
    const named = new Set<number>();
    const dropped = new Set<number>();
    order.forEach(({ task }, index) => {
      const step = lanes[task][next[task]];
      next[task] += 1;
      steps.push(step);
      if (step.type === "start") running.add(task);
      if (step.type === "notification" || step.type === "updated") {
        running.delete(task);
        settled.add(task);
      }
      if (step.type === "start" && redeliver[index]) {
        steps.push({ type: "start", task, redelivery: true });
      }
      if (setAfter[index]) {
        const live = [...running].filter((id) => plans[id].backgrounded && !dropped.has(id));
        const dropping = live.filter((id) => plans[id].end === "dropped-from-set" && named.has(id));
        for (const id of dropping) dropped.add(id);
        const lagging = [...settled].filter((id) => plans[id].backgrounded && redeliver[index]);
        const names = live.filter((id) => !dropping.includes(id));
        for (const id of names) named.add(id);
        steps.push({ type: "set", lagging: [...names, ...lagging], dropping });
      }
    });
    return { plans, steps };
  });
});

const taskId = (task: number) => `task-${task}`;
const activityLine = (task: number, n: number) => `Running cd /Users/operator/worktrees/${task} && ls  -la\n# step ${n}`;
/** The line the tracker keeps: one line, whitespace collapsed. */
const shownActivity = (task: number, n: number) => activityLine(task, n).replace(/\s+/g, " ");

function message(step: Step, plans: TaskPlan[]): SDKMessage {
  if (step.type === "set") {
    return {
      type: "system", subtype: "background_tasks_changed",
      tasks: step.lagging.map((task) => ({
        task_id: taskId(task),
        task_type: plans[task].kind === "agent" ? "local_agent" : "local_bash",
        description: `Task ${task}`,
        ...(plans[task].kind === "agent" ? { subagent_type: "general-purpose" } : {}),
      })),
    } as unknown as SDKMessage;
  }
  const plan = plans[step.task];
  const base = { type: "system", task_id: taskId(step.task), tool_use_id: `tool-${step.task}` };
  switch (step.type) {
    case "start":
      return {
        ...base, subtype: "task_started", description: `Task ${step.task}`,
        task_type: plan.kind === "agent" ? "local_agent" : "local_bash",
        ...(plan.kind === "agent" ? { subagent_type: "general-purpose" } : {}),
        is_backgrounded: plan.backgrounded,
      } as unknown as SDKMessage;
    case "progress":
      return {
        // Claude's progress description is the worker's latest activity,
        // not its task: a bare command when the call named none (captured
        // from claude-agent-sdk 0.3.330).
        ...base, subtype: "task_progress", description: activityLine(step.task, step.n),
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, last_tool_name: "Bash",
      } as unknown as SDKMessage;
    case "updated":
      return {
        ...base, subtype: "task_updated",
        patch: { status: step.status === "stopped" ? "killed" : step.status },
      } as unknown as SDKMessage;
    case "notification":
      return {
        ...base, subtype: "task_notification", status: step.status, output_file: "",
        summary: `Task ${step.task} ${step.status}`,
      } as unknown as SDKMessage;
  }
}

const CARD_STATUS: Record<Terminal, string> = {
  completed: "success",
  failed: "failure",
  stopped: "cancelled",
};

describe("Claude sub-agent projection", () => {
  it("never shows a sub-agent in Actions, keeps it in Waiting For, and gives it one card that follows its lifecycle", () => {
    fc.assert(fc.property(scenario, ({ plans, steps }) => {
      const tracker = new ClaudeTaskTracker(() => 1_000);
      // Model, from the event stream alone.
      const started: number[] = [];
      const settled = new Map<number, Terminal>();
      const named = new Set<number>();
      let liveSet: Set<number> | undefined;
      const terminalCards = new Set<string>();
      const latestActivity = new Map<number, string>();

      for (const step of steps) {
        tracker.apply(message(step, plans));
        if (step.type === "start" && !started.includes(step.task)) started.push(step.task);
        if (step.type === "progress") latestActivity.set(step.task, shownActivity(step.task, step.n));
        if ((step.type === "updated" || step.type === "notification") && !settled.has(step.task)) {
          settled.set(step.task, step.status);
        }
        if (step.type === "set") {
          liveSet = new Set(step.lagging);
          for (const task of step.lagging) named.add(task);
        }
        const runs = (task: number) => !settled.has(task)
          && (!plans[task].backgrounded || !liveSet || liveSet.has(task));
        const dropped = (task: number) => !settled.has(task) && plans[task].backgrounded
          && named.has(task) && liveSet !== undefined && !liveSet.has(task);

        // Waiting For: every running task, commands and sub-agents.
        expect(tracker.active().map((task) => task.taskId)).toEqual(started.filter(runs).map(taskId));

        // Actions: running commands only.
        const rows = tracker.actionTasks().map((task) => claudeTaskRow(task, { cwd: "/repo" }));
        expect(rows.map((row) => row.processId))
          .toEqual(started.filter((task) => plans[task].kind === "bash" && runs(task)).map(taskId));
        expect(rows.filter((row) => row.kind === "agent")).toEqual([]);

        // Cards: one per sub-agent, in start order, matching the model.
        const agents = started.filter((task) => plans[task].kind === "agent");
        const cards = tracker.subAgentCards();
        expect(cards.map((card) => card.monitorId))
          .toEqual(agents.map((task) => `${CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}${taskId(task)}`));
        cards.forEach((card, index) => {
          const task = agents[index];
          const ended = settled.get(task);
          expect(card.status).toBe(ended ? CARD_STATUS[ended] : dropped(task) ? "success" : "running");
          // The card keeps the name the Agent call gave it, whatever it is doing.
          expect(card.task).toBe(`Task ${task}`);
          // Once a card ends it never runs again.
          if (card.status !== "running") terminalCards.add(card.monitorId);
          else expect(terminalCards.has(card.monitorId)).toBe(false);
        });

        // Activity: the latest progress line of each card that still runs.
        // The lines are a set: each event names what changed, not an order.
        const byCard = (left: { monitorId: string }, right: { monitorId: string }) => left.monitorId.localeCompare(right.monitorId);
        expect(tracker.subAgentActivities().sort(byCard)).toEqual(cards.flatMap((card, index) => {
          const activity = latestActivity.get(agents[index]!);
          return card.status === "running" && activity ? [{ monitorId: card.monitorId, activity }] : [];
        }).sort(byCard));
      }
    }));
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

describe("Claude sub-agent activity work", () => {
  it("reads only the sub-agents holding a line, not the session's settled tasks", () => {
    const tracker = new ClaudeTaskTracker(() => 1_000);
    const start = (id: string) => tracker.apply({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `tool-${id}`,
      description: `Task ${id}`, task_type: "local_agent", is_backgrounded: false } as unknown as SDKMessage);
    const progress = (id: string, n: number) => tracker.apply({ type: "system", subtype: "task_progress", task_id: id,
      tool_use_id: `tool-${id}`, description: `Running step ${n}`, usage: { total_tokens: 1, tool_uses: n, duration_ms: 1 },
      last_tool_name: "Bash" } as unknown as SDKMessage);
    // A long session: 200 sub-agents that worked and settled.
    for (let task = 0; task < 200; task += 1) {
      start(`old-${task}`);
      progress(`old-${task}`, 1);
      tracker.apply({ type: "system", subtype: "task_notification", task_id: `old-${task}`, tool_use_id: `tool-old-${task}`,
        status: "completed", output_file: "", summary: "done" } as unknown as SDKMessage);
    }
    tracker.subAgentActivities();
    start("live");
    const tasks = new CountingMap((tracker as unknown as { tasks: Map<string, unknown> }).tasks);
    Object.assign(tracker, { tasks });
    for (let n = 0; n < 50; n += 1) {
      progress("live", n);
      expect(tracker.subAgentActivities()).toEqual([{ monitorId: `${CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}live`, activity: `Running step ${n}` }]);
    }
    // Before, each read walked all 201 tasks: 10,050 visits for 50 steps.
    expect(tasks.visits).toBe(0);
  });
});

describe("claudeSubAgentActivityText", () => {
  it("cuts before an emoji that straddles the limit, not through it", () => {
    const text = `${"a".repeat(CLAUDE_SUB_AGENT_ACTIVITY_MAX_LENGTH - 2)}😀 and more`;
    expect(claudeSubAgentActivityText(text)).toBe(`${"a".repeat(CLAUDE_SUB_AGENT_ACTIVITY_MAX_LENGTH - 2)}😀…`);
  });

  it("keeps one bounded line and never strands half a character", () => {
    const piece = fc.constantFrom("a", " ", "\n", "/", "👩🏽‍💻", "😀", "東京", "é");
    fc.assert(fc.property(fc.array(piece, { maxLength: 400, size: "max" }).map((parts) => parts.join("")), (text) => {
      const line = claudeSubAgentActivityText(text);
      const collapsed = text.replace(/\s+/g, " ").trim();
      if (!collapsed) {
        expect(line).toBeUndefined();
        return;
      }
      expect(line).toBe(line!.toWellFormed());
      expect(Array.from(line!).length).toBeLessThanOrEqual(CLAUDE_SUB_AGENT_ACTIVITY_MAX_LENGTH);
      // Either the whole line, or its start with an ellipsis.
      if (line !== collapsed) {
        expect(line!.endsWith("…")).toBe(true);
        expect(collapsed.startsWith(line!.slice(0, -1))).toBe(true);
      }
    }));
  });
});
