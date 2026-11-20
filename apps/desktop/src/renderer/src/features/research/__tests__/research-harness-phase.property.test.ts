import fc from "fast-check";
import { expect, it } from "vitest";
import { researchRunAttention, type ResearchRun } from "@pwragent/shared/research";
import { type ResearchHarnessState } from "@pwragent/shared/research-harness";
import { researchHarnessOutcome, researchRunPhase } from "../research-view-model";

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
    const live = input.status === "running" || input.status === "stopping";
    if (state === "unknown") expect(phase).toEqual({ label: "Outcome unknown", tone: "attention" });
    // An owner that died mid-run leaves the last Harness state pending or running on a retired run.
    // Nothing is running it: the chip must not say it is, and the card must offer the way forward.
    if (!live && input.status !== "completed" && (state === "pending" || state === "running")) {
      expect(phase).toEqual({ label: "Outcome unknown", tone: "attention" });
      expect(researchHarnessOutcome(input)).toBeDefined();
    }
    // The chip's tone and the run list's group are one rule.
    expect(phase.tone === "attention" ? "needs_you" : phase.tone === "live" ? "live" : "retained").toBe(researchRunAttention(input));
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

it("groups a native run in the run list by the same rule its chip follows", () => {
  const native = fc.record({ status, activeWorkers: fc.nat(8), unreviewed: fc.nat(3), accepted: fc.nat(3) });
  fc.assert(fc.property(native, (input) => {
    const tone = researchRunPhase(input).tone;
    expect(tone === "attention" ? "needs_you" : tone === "live" ? "live" : "retained").toBe(researchRunAttention(input));
  }), { numRuns: 300 });
});
