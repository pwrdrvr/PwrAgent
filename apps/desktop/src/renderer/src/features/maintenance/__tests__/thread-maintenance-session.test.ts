import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  INITIAL_THREAD_MAINTENANCE_SESSION,
  sessionCanDiscard,
  threadMaintenanceSessionReducer,
  type ThreadMaintenanceSessionAction,
  type ThreadMaintenanceSessionState,
} from "../thread-maintenance-session";
import type { ThreadMaintenancePhase } from "../thread-maintenance-run-state";

const PHASES: ThreadMaintenancePhase[] = ["plan", "scanning", "threads", "hibernate", "checkouts", "running", "finished"];

const action: fc.Arbitrary<ThreadMaintenanceSessionAction> = fc.oneof(
  fc.record({ type: fc.constant("launch" as const), projectKey: fc.option(fc.constantFrom("/src/a", "/src/b"), { nil: undefined }) })
    .map(({ projectKey, ...rest }) => ({ ...rest, ...(projectKey ? { projectKey } : {}) })),
  fc.constant({ type: "minimize" as const }),
  fc.constant({ type: "restore" as const }),
  fc.constant({ type: "hideNotice" as const }),
  fc.constant({ type: "discard" as const }),
  fc.record({ phase: fc.constantFrom(...PHASES), detail: fc.option(fc.constantFrom("3 found", "4 / 9"), { nil: undefined }) })
    .map(({ phase, detail }) => ({ type: "status" as const, status: { phase, ...(detail ? { detail } : {}) } })),
);

/** The rule, written out longhand: a session lives from its first launch to
 * an explicit discard, whatever else happens to it. */
type Model = { live: boolean; id: number; started: number; projectKey?: string; minimized: boolean; hidden: boolean; phase?: ThreadMaintenancePhase };

function step(model: Model, next: ThreadMaintenanceSessionAction): Model {
  switch (next.type) {
    case "launch":
      return model.live
        ? { ...model, minimized: false, hidden: false }
        : { live: true, id: model.started + 1, started: model.started + 1, ...(next.projectKey ? { projectKey: next.projectKey } : {}),
          minimized: false, hidden: false };
    case "minimize": return model.live ? { ...model, minimized: true, hidden: model.minimized ? model.hidden : false } : model;
    case "restore": return model.live ? { ...model, minimized: false, hidden: false } : model;
    case "hideNotice": return model.live && model.minimized ? { ...model, hidden: true } : model;
    case "discard": return { live: false, id: 0, started: model.started, minimized: false, hidden: false };
    case "status": {
      if (!model.live) return model;
      const changed = model.phase !== undefined && model.phase !== next.status.phase;
      return { ...model, phase: next.status.phase, hidden: changed ? false : model.hidden };
    }
  }
}

describe("thread maintenance session, as a model", () => {
  it("keeps one session from launch to discard, and only discard ends it", () => {
    fc.assert(fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
      let state: ThreadMaintenanceSessionState = INITIAL_THREAD_MAINTENANCE_SESSION;
      let model: Model = { live: false, id: 0, started: 0, minimized: false, hidden: false };
      for (const next of actions) {
        const before = state.session?.id;
        state = threadMaintenanceSessionReducer(state, next);
        model = step(model, next);
        expect(Boolean(state.session)).toBe(model.live);
        if (!state.session) continue;
        expect(state.session.id).toBe(model.id);
        // Only a launch with no session can start one; nothing replaces it.
        if (before !== undefined) expect(state.session.id).toBe(before);
        expect(state.session.projectKey).toBe(model.projectKey);
        expect(state.session.minimized).toBe(model.minimized);
        expect(state.session.noticeHidden).toBe(model.hidden);
        // The notice can be hidden only while the session is minimized.
        if (state.session.noticeHidden) expect(state.session.minimized).toBe(true);
      }
    }));
  });

  it("reopens an edited plan from File or Settings rather than starting over", () => {
    const reduce = (actions: ThreadMaintenanceSessionAction[]) => actions.reduce(threadMaintenanceSessionReducer, INITIAL_THREAD_MAINTENANCE_SESSION);
    const minimized = reduce([
      { type: "launch" },
      { type: "status", status: { phase: "plan" } },
      { type: "minimize" },
    ]);
    // Settings → Review… names a project; the session already open wins.
    const reopened = threadMaintenanceSessionReducer(minimized, { type: "launch", projectKey: "/src/harbor-web" });
    expect(reopened.session).toEqual({ id: minimized.session!.id, minimized: false, noticeHidden: false });
    expect(reopened.status).toEqual({ phase: "plan" });
  });

  it("brings a hidden notice back when a scan or run moves on, and not before", () => {
    let state = [
      { type: "launch" },
      { type: "status", status: { phase: "scanning", detail: "0 / 9" } },
      { type: "minimize" },
      { type: "hideNotice" },
    ].reduce((current, next) => threadMaintenanceSessionReducer(current, next as ThreadMaintenanceSessionAction),
      INITIAL_THREAD_MAINTENANCE_SESSION);
    state = threadMaintenanceSessionReducer(state, { type: "status", status: { phase: "scanning", detail: "4 / 9" } });
    expect(state.session?.noticeHidden).toBe(true);
    state = threadMaintenanceSessionReducer(state, { type: "status", status: { phase: "hibernate", detail: "3 found" } });
    expect(state.session).toMatchObject({ minimized: true, noticeHidden: false });
  });

  it("never offers Discard while a scan or run is under way", () => {
    fc.assert(fc.property(fc.constantFrom(...PHASES), (phase) => {
      expect(sessionCanDiscard({ phase })).toBe(phase !== "scanning" && phase !== "running");
    }));
  });
});
