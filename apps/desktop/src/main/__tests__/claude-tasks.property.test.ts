import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_SUB_AGENT_MONITOR_ID_PREFIX,
  ClaudeTaskTracker,
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
 *
 * The model is the event stream itself: each task's lifecycle as Claude
 * reports it, with notifications that race task_updated and a live set that
 * lags a settlement.
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
};

type Step =
  | { type: "start"; task: number; redelivery: boolean }
  | { type: "progress"; task: number }
  | { type: "updated"; task: number; status: Terminal }
  | { type: "notification"; task: number; status: Terminal }
  | { type: "set"; lagging: number[]; dropping: number[] };

const taskPlan = fc.record<TaskPlan>({
  kind: fc.constantFrom<TaskKind>("agent", "bash"),
  backgrounded: fc.boolean(),
  end: fc.constantFrom("notification", "updated-then-notification", "dropped-from-set", "none"),
  status: fc.constantFrom<Terminal>("completed", "failed", "stopped"),
  progress: fc.nat({ max: 2 }),
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
    for (let i = 0; i < plan.progress; i += 1) steps.push({ type: "progress", task });
    if (plan.end === "updated-then-notification") {
      steps.push({ type: "updated", task, status: plan.status });
      steps.push({ type: "notification", task, status: plan.status });
    } else if (plan.end === "notification") {
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
        ...base, subtype: "task_progress", description: `Task ${step.task}`,
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, last_tool_name: "Read",
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
  it("never shows a sub-agent in Actions, and gives each one card that follows its lifecycle", () => {
    fc.assert(fc.property(scenario, ({ plans, steps }) => {
      const tracker = new ClaudeTaskTracker(() => 1_000);
      // Model: each started task's card status, or none for a command.
      const model = new Map<number, string>();
      const terminalCards = new Set<string>();

      for (const step of steps) {
        tracker.apply(message(step, plans));
        if (step.type === "start" && plans[step.task].kind === "agent" && !model.has(step.task)) {
          model.set(step.task, "running");
        }
        if ((step.type === "updated" || step.type === "notification") && plans[step.task].kind === "agent") {
          model.set(step.task, CARD_STATUS[step.status]);
        }
        if (step.type === "set") {
          for (const task of step.dropping) {
            if (plans[task].kind === "agent" && model.get(task) === "running") model.set(task, "success");
          }
        }

        // Actions: commands only, every running command.
        const rows = tracker.actionTasks().map((task) => claudeTaskRow(task, { cwd: "/repo" }));
        expect(rows.filter((row) => row.kind === "agent")).toEqual([]);
        const activeCommands = tracker.active()
          .filter((task) => task.taskType !== "local_agent")
          .map((task) => task.taskId);
        expect(rows.map((row) => row.processId)).toEqual(activeCommands);

        // Cards: one per sub-agent, in start order, matching the model.
        const cards = tracker.subAgentCards();
        expect(cards.map((card) => card.monitorId))
          .toEqual([...model.keys()].map((task) => `${CLAUDE_SUB_AGENT_MONITOR_ID_PREFIX}${taskId(task)}`));
        for (const card of cards) {
          const task = Number(card.taskId.slice("task-".length));
          expect(card.status).toBe(model.get(task));
          if (card.status !== "running") terminalCards.add(card.monitorId);
          else expect(terminalCards.has(card.monitorId)).toBe(false);
        }
      }
    }));
  });
});
