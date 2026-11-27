import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadSubAgentStatus } from "@pwragent/shared/contracts/navigation";
import { isRunningSubAgent, summarizeDetailsJobs } from "../details-model";

const statuses: ThreadSubAgentStatus[] = ["running", "success", "failure", "cancelled", "blocked", "failed"];

// Few monitors and attempts, so the two lists often name the same attempt.
const subAgentsArb = fc.array(fc.record({
  monitorId: fc.constantFrom("m1", "m2", "m3", "m4"),
  attemptId: fc.option(fc.constantFrom("a1", "a2"), { nil: undefined }),
  status: fc.constantFrom(...statuses),
  task: fc.constant("task"),
  createdAt: fc.constant(1),
  updatedAt: fc.constant(1),
}), { maxLength: 6 });

const key = (subAgent: { monitorId: string; attemptId?: string }) => `${subAgent.monitorId}/${subAgent.attemptId ?? ""}`;

describe("the Jobs count", () => {
  // The navigation row carries only the owner's active projection; the full
  // list loads with the Sub-agents panel. Counting the full list alone left
  // Jobs at zero, and the spine dot dark, while sub-agents ran.
  it("counts a running sub-agent the owner projects before the full list loads", () => {
    const summary = summarizeDetailsJobs({
      terminalCount: 0,
      runs: [],
      subAgents: [],
      activeSubAgents: [{ monitorId: "m1", task: "task", status: "running", createdAt: 1, updatedAt: 1 }],
    });
    expect(summary.running).toBe(1);
    expect(summary.order[0]).toBe("subagents");
  });

  it("counts each running monitor attempt once, the full summary deciding where both name it", () => {
    fc.assert(fc.property(subAgentsArb, subAgentsArb, (full, active) => {
      // Oracle: last word per attempt, the full list after the projection.
      const latest = new Map<string, (typeof full)[number]>();
      for (const subAgent of [...active, ...full]) latest.set(key(subAgent), subAgent);
      const expected = [...latest.values()].filter(isRunningSubAgent).length;
      const summary = summarizeDetailsJobs({ terminalCount: 0, runs: [], subAgents: full, activeSubAgents: active });
      expect(summary.runningSubAgents).toBe(expected);
      expect(summary.running).toBe(expected);
    }));
  });
});
