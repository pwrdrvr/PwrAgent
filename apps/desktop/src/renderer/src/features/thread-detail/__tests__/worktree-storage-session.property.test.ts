import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  ReadWorktreeReflinkCapabilitiesResponse,
  RunWorktreeReflinkRequest,
  RunWorktreeReflinkResponse,
  WorktreeReflinkCapabilities,
  WorktreeReflinkSummary,
} from "@pwragent/shared/contracts/worktree-reflink";
import {
  INITIAL_WORKTREE_STORAGE_STATE,
  reduceWorktreeStorage,
  restartWorktreeStorage,
  worktreeStorageRunRequest,
  type WorktreeStorageState,
} from "../worktree-storage-session";

// The model: the main process has one Git selected and answers each request
// for the Git selected when it gets round to it. Answers reach the dialog in
// any order, some after the selection has moved on. What each release
// supports is the oracle.
type Version = "pwrgit.1" | "pwrgit.2" | "stock";
const VERSIONS: Version[] = ["pwrgit.1", "pwrgit.2", "stock"];
const TRUTH: Record<Version, WorktreeReflinkCapabilities> = {
  "pwrgit.1": { reflink: true, verifyFilters: false },
  "pwrgit.2": { reflink: true, verifyFilters: true },
  "stock": { reflink: false, verifyFilters: false },
};
const TARGET = { threadId: "thread", worktreePath: "/work/wt" };

type Operation =
  | { kind: "select"; version: Version }
  | { kind: "request-capabilities" }
  | { kind: "tick"; checked: boolean }
  | { kind: "start"; mode: "estimate" | "share" }
  | { kind: "deliver"; pick: number };

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...VERSIONS).map((version): Operation => ({ kind: "select", version })) },
  { weight: 3, arbitrary: fc.constant<Operation>({ kind: "request-capabilities" }) },
  { weight: 3, arbitrary: fc.boolean().map((checked): Operation => ({ kind: "tick", checked })) },
  { weight: 3, arbitrary: fc.constantFrom("estimate" as const, "share" as const).map((mode): Operation => ({ kind: "start", mode })) },
  { weight: 6, arbitrary: fc.nat({ max: 7 }).map((pick): Operation => ({ kind: "deliver", pick })) },
);

function summary(): WorktreeReflinkSummary {
  return {
    scanned: 3, eligible: 1, alreadyShared: 1, reshared: 1, skipped: 1, failed: 0,
    observedPrivateReduction: 10, potentialPrivateReduction: 10, allocationUnknown: 0,
  };
}

/** What the main process does with a run request, for the Git selected now. */
function mainRun(selected: Version, request: RunWorktreeReflinkRequest): RunWorktreeReflinkResponse {
  const runtime = { capabilities: TRUTH[selected], runtimeKey: selected };
  if (request.mode === "share" && request.runtimeKey !== selected) return { status: "runtime-changed", ...runtime };
  if (!runtime.capabilities.reflink) return { status: "failed", reason: "no reflink" };
  const verifies = request.mode === "share" && request.verifyFilters === true;
  if (verifies && !runtime.capabilities.verifyFilters) return { status: "failed", reason: "no verify" };
  return {
    status: "completed", mode: request.mode, verifiedFilters: verifies, supported: true,
    summary: summary(), ...runtime,
  };
}

describe("worktree storage session", () => {
  it("never carries the operator's opt-in, or a result, from one Git to another", () => {
    fc.assert(fc.property(
      fc.constantFrom(...VERSIONS),
      // `size: "max"` so runs reach the long orders that matter: read, tick,
      // switch, read again, with a run in flight across the switch.
      fc.array(operationArbitrary, { minLength: 1, maxLength: 60, size: "max" }),
      (initial, operations) => {
        let selected = initial;
        let state: WorktreeStorageState = INITIAL_WORKTREE_STORAGE_STATE;
        /** The Git on screen when the operator last ticked the box. */
        let tickedFor: string | undefined;
        const measuredFor = new WeakMap<WorktreeReflinkSummary, string>();
        const pending: Array<
          | { kind: "capabilities"; request: number }
          | { kind: "run"; request: number; sent: RunWorktreeReflinkRequest }
        > = [];

        for (const operation of operations) {
          if (operation.kind === "select") {
            selected = operation.version;
          } else if (operation.kind === "request-capabilities") {
            state = reduceWorktreeStorage(state, { type: "capabilities-requested" });
            pending.push({ kind: "capabilities", request: state.capabilityRequest });
          } else if (operation.kind === "tick") {
            state = reduceWorktreeStorage(state, { type: "verify-filters-set", checked: operation.checked });
            if (state.verifyFilters) tickedFor = state.runtime?.runtimeKey;
          } else if (operation.kind === "start") {
            const sent = worktreeStorageRunRequest(state, TARGET, operation.mode);
            const before = state.runRequest;
            state = reduceWorktreeStorage(state, { type: "run-started", mode: operation.mode });
            if (sent && state.runRequest !== before) {
              // An estimate never asks for filters. A share asks only with
              // the box ticked, for the Git it was ticked under.
              if (operation.mode === "estimate") expect(sent.verifyFilters).toBeUndefined();
              if (sent.verifyFilters) {
                expect(operation.mode).toBe("share");
                expect(sent.runtimeKey).toBe(tickedFor);
                expect(TRUTH[sent.runtimeKey as Version].verifyFilters).toBe(true);
              }
              pending.push({ kind: "run", request: state.runRequest, sent });
            } else {
              expect(state.runRequest).toBe(before);
            }
          } else if (pending.length > 0) {
            const [answer] = pending.splice(operation.pick % pending.length, 1);
            const previous = state;
            if (answer.kind === "capabilities") {
              const response: ReadWorktreeReflinkCapabilitiesResponse = {
                status: "ready", capabilities: TRUTH[selected], runtimeKey: selected,
              };
              state = reduceWorktreeStorage(state, { type: "capabilities-answered", request: answer.request, response });
              // Only the newest request's answer counts.
              if (answer.request !== previous.capabilityRequest) expect(state).toBe(previous);
            } else {
              const response = mainRun(selected, answer.sent);
              if (response.status === "completed") {
                measuredFor.set(response.summary, response.runtimeKey);
                // Filters ran: for the Git the box was ticked under, and it has them.
                if (response.verifiedFilters) {
                  expect(answer.sent.runtimeKey).toBe(selected);
                  expect(TRUTH[selected].verifyFilters).toBe(true);
                }
              }
              state = reduceWorktreeStorage(state, { type: "run-answered", request: answer.request, response });
              if (answer.request !== previous.runRequest) expect(state).toBe(previous);
            }
          }

          if (state.verifyFilters) {
            expect(state.runtime?.capabilities.verifyFilters).toBe(true);
            expect(state.runtime?.runtimeKey).toBe(tickedFor);
          }
          for (const outcome of [state.estimate, state.shared]) {
            if (outcome) expect(measuredFor.get(outcome.summary)).toBe(state.runtime?.runtimeKey);
          }
          if (state.runtime) expect(state.runtime.capabilities).toEqual(TRUTH[state.runtime.runtimeKey as Version]);
        }
      },
    ));
  });

  // The switch, by name: ticked under .2, .1 selected, then .2 again.
  it("clears the tick when .1 replaces .2, and does not restore it when .2 returns", () => {
    const answer = (state: WorktreeStorageState, version: Version): WorktreeStorageState => {
      const requested = reduceWorktreeStorage(state, { type: "capabilities-requested" });
      return reduceWorktreeStorage(requested, {
        type: "capabilities-answered",
        request: requested.capabilityRequest,
        response: { status: "ready", capabilities: TRUTH[version], runtimeKey: version },
      });
    };
    let state = answer(INITIAL_WORKTREE_STORAGE_STATE, "pwrgit.2");
    state = reduceWorktreeStorage(state, { type: "verify-filters-set", checked: true });
    expect(worktreeStorageRunRequest(state, TARGET, "share")).toMatchObject({ verifyFilters: true });
    expect(worktreeStorageRunRequest(state, TARGET, "estimate")).not.toHaveProperty("verifyFilters");

    state = answer(state, "pwrgit.1");
    expect(state.verifyFilters).toBe(false);
    expect(state.runtimeChanged).toBe(true);
    expect(reduceWorktreeStorage(state, { type: "verify-filters-set", checked: true }).verifyFilters).toBe(false);
    expect(worktreeStorageRunRequest(state, TARGET, "share")).not.toHaveProperty("verifyFilters");

    state = answer(state, "pwrgit.2");
    expect(state.verifyFilters).toBe(false);
    expect(worktreeStorageRunRequest(state, TARGET, "share")).not.toHaveProperty("verifyFilters");
  });

  it("does not take an answer addressed to the worktree it showed before", () => {
    let state = reduceWorktreeStorage(INITIAL_WORKTREE_STORAGE_STATE, { type: "capabilities-requested" });
    const previous = state.capabilityRequest;
    // Another worktree takes the session, and asks its own first question.
    state = reduceWorktreeStorage(restartWorktreeStorage(state), { type: "capabilities-requested" });
    expect(state.capabilityRequest).not.toBe(previous);
    expect(state.runtime).toBeUndefined();
    const late = reduceWorktreeStorage(state, {
      type: "capabilities-answered",
      request: previous,
      response: { status: "ready", capabilities: TRUTH["pwrgit.2"], runtimeKey: "pwrgit.2" },
    });
    expect(late).toBe(state);
  });

  it("drops the error from an unreadable probe once the capabilities are read, and keeps a run's error", () => {
    let state = reduceWorktreeStorage(INITIAL_WORKTREE_STORAGE_STATE, { type: "capabilities-requested" });
    state = reduceWorktreeStorage(state, {
      type: "capabilities-failed", request: state.capabilityRequest, reason: "not ready",
    });
    expect(state.error).toBe("not ready");
    const ready = (from: WorktreeStorageState): WorktreeStorageState => {
      const requested = reduceWorktreeStorage(from, { type: "capabilities-requested" });
      return reduceWorktreeStorage(requested, {
        type: "capabilities-answered",
        request: requested.capabilityRequest,
        response: { status: "ready", capabilities: TRUTH["pwrgit.2"], runtimeKey: "pwrgit.2" },
      });
    };
    state = ready(state);
    expect(state.error).toBeUndefined();

    state = reduceWorktreeStorage(state, { type: "run-started", mode: "share" });
    state = reduceWorktreeStorage(state, {
      type: "run-answered", request: state.runRequest, response: { status: "failed", reason: "index file corrupt" },
    });
    // A refresh on window focus must not erase why the share failed.
    expect(ready(state).error).toBe("index file corrupt");
  });

  it("ignores a .2 capability answer that arrives after the answer to a newer request", () => {
    let state = reduceWorktreeStorage(INITIAL_WORKTREE_STORAGE_STATE, { type: "capabilities-requested" });
    const stale = state.capabilityRequest;
    state = reduceWorktreeStorage(state, { type: "capabilities-requested" });
    state = reduceWorktreeStorage(state, {
      type: "capabilities-answered",
      request: state.capabilityRequest,
      response: { status: "ready", capabilities: TRUTH["pwrgit.1"], runtimeKey: "pwrgit.1" },
    });
    const late = reduceWorktreeStorage(state, {
      type: "capabilities-answered",
      request: stale,
      response: { status: "ready", capabilities: TRUTH["pwrgit.2"], runtimeKey: "pwrgit.2" },
    });
    expect(late).toBe(state);
    expect(late.runtime?.capabilities.verifyFilters).toBe(false);
  });
});
