import type { AppServerCollaborationModeRequest } from "@pwragent/shared/contracts/agent";

/** The collaboration mode a Plan send asks the backend for. */
export const PLAN_COLLABORATION_MODE = {
  mode: "plan",
  settings: {
    developerInstructions: null,
  },
} as const satisfies AppServerCollaborationModeRequest;

/**
 * How the composer sends a message:
 * - `turn`: starts a turn now, or waits in the owner's queue for one.
 * - `scheduled`: the owner starts the turn at a set time.
 * - `local-queue`: waits in this window until its thread exists.
 * - `steer`: adds to the turn that is already running.
 */
export type ComposerSendRoute = "turn" | "scheduled" | "local-queue" | "steer";

export type PlanModeForSend = {
  /**
   * Sent with the message, or for a steer with the new turn it starts if the
   * running turn has already ended; undefined when Plan is off.
   */
  collaborationMode?: AppServerCollaborationModeRequest;
  /** Plan was on and this send used it up, so the toggle turns off. */
  clearPlan: boolean;
  /** Plan was on but cannot apply to the turn this send joins. */
  notApplied: boolean;
};

/**
 * Plan is one-shot: every send made while it is on carries Plan to any new
 * turn it starts and turns the toggle off, so Plan never lingers to plan a
 * later message. A steer joins a turn that already has its own mode, so it
 * says Plan did not apply there.
 */
export function planModeForSend(route: ComposerSendRoute, planOn: boolean): PlanModeForSend {
  if (!planOn) return { clearPlan: false, notApplied: false };
  return {
    collaborationMode: PLAN_COLLABORATION_MODE,
    clearPlan: true,
    notApplied: route === "steer",
  };
}

export const PLAN_NOT_APPLIED_TO_STEER =
  "This message joins the running turn, which keeps its own mode, so Plan mode is off. "
  + "If that turn has already ended, the message starts a new turn in Plan mode.";

/**
 * The composer scopes (threads and launchpads) with Plan on. One composer
 * serves every thread it moves between, so each scope keeps its own Plan and
 * turning it on or off in one never touches another. Returns `scopes` itself
 * when nothing changes, so React skips the update.
 */
export function withPlanMode(
  scopes: ReadonlySet<string>,
  scopeKey: string,
  on: boolean,
): ReadonlySet<string> {
  if (scopes.has(scopeKey) === on) return scopes;
  const next = new Set(scopes);
  if (on) next.add(scopeKey);
  else next.delete(scopeKey);
  return next;
}
