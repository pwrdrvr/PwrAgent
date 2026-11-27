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
  /** Sent with the message; undefined when it goes in the default mode. */
  collaborationMode?: AppServerCollaborationModeRequest;
  /** Plan was on and this send used it up, so the toggle turns off. */
  clearPlan: boolean;
  /** Plan was on but cannot apply to this send. */
  notApplied: boolean;
};

/**
 * Plan is one-shot: every send made while it is on either carries Plan or
 * turns it off and says so, so it never lingers to plan a later message.
 * A steer joins a turn that already has its own mode, so Plan cannot apply.
 */
export function planModeForSend(route: ComposerSendRoute, planOn: boolean): PlanModeForSend {
  if (!planOn) return { clearPlan: false, notApplied: false };
  if (route === "steer") return { clearPlan: true, notApplied: true };
  return { collaborationMode: PLAN_COLLABORATION_MODE, clearPlan: true, notApplied: false };
}

export const PLAN_NOT_APPLIED_TO_STEER =
  "Plan mode applies to new turns. This message was added to the running turn, so Plan mode is off.";
