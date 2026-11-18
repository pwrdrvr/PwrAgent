import fc from "fast-check";
import { expect, it } from "vitest";
import type { ResearchHarnessState, ResearchRun } from "@pwragent/shared";
import { researchRunPhase } from "../research-view-model";

/**
 * The run chip is the operator's first answer to "did this happen?". For a
 * Harness run it must follow the owner's Harness state, not the native status
 * the owner stores to retire the run: a complete import is not a failure, an
 * unacknowledged stop is not a stop, and an unknown outcome is never hidden.
 */
const harnessState = fc.constantFrom<ResearchHarnessState["state"]>("pending", "running", "imported", "unknown", "stopping", "stopped", "ended", "reconciling");
const status = fc.constantFrom<ResearchRun["status"]>("running", "stopping", "completed", "deadline", "stopped", "exhausted", "interrupted");
const run = fc.record({
  status, state: harnessState, mode: fc.constantFrom<"execute" | "import">("execute", "import"), source: fc.constantFrom<"swarm" | "discovery">("swarm", "discovery"),
  activeWorkers: fc.nat(8), unreviewed: fc.nat(3), accepted: fc.nat(3),
})
  // The owner completes a Harness run only after its source outcome settled (ended, imported or a confirmed stop).
  .filter((r) => r.status !== "completed" || ["ended", "imported", "stopped"].includes(r.state))
  .map((r) => ({ status: r.status, activeWorkers: r.activeWorkers, unreviewed: r.unreviewed, accepted: r.accepted, harness: {
  version: 1, mode: r.source === "discovery" ? "import" : r.mode, source: r.source, project: "p", session: "s", swarm: "w", workspace: "/w",
  upstreamRevision: "r", state: r.state, cursor: 0, members: [], cancelSupported: r.mode === "execute", note: "",
} as ResearchHarnessState }));

it("derives a Harness run's chip from its source state without reporting an unconfirmed stop or hiding an unknown outcome", () => {
  fc.assert(fc.property(run, (input) => {
    const phase = researchRunPhase(input);
    const state = input.harness.state;
    if (state === "unknown") expect(phase).toEqual({ label: "Outcome unknown", tone: "attention" });
    if (state === "imported" && input.status !== "completed") {
      expect(phase.tone).not.toBe("problem");
      expect(phase.label).toBe(input.harness.source === "discovery" ? "Snapshot" : "Imported");
    }
    if (phase.label === "Stopped") expect(state).toBe("stopped");
    if (state === "stopping") expect(phase.label).toBe(input.status === "stopping" ? "Stopping" : "Stop unconfirmed");
    if (state === "reconciling") expect(phase).toEqual({ label: "Reconciling", tone: "live" });
    if (input.status === "completed") expect(phase).toEqual({ label: "Completed", tone: "done" });
  }), { numRuns: 400 });
});
