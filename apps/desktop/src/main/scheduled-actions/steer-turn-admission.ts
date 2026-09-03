import { createHash } from "node:crypto";
import type {
  SteerTurnRequest,
  SteerTurnResponse,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import type { ScheduledThreadActionService } from "./scheduled-thread-action-service.js";

const STALE_STEER_HOLD_REASON =
  "The active turn ended before this steering message could be delivered. Review the turn result, then retry this queued message.";

export async function admitSteerTurn(
  registry: Pick<DesktopBackendRegistry, "steerTurn">,
  scheduler: Pick<ScheduledThreadActionService, "create">,
  request: SteerTurnRequest,
): Promise<SteerTurnResponse> {
  try {
    const response = await registry.steerTurn(request);
    return response.disposition
      ? response
      : { ...response, disposition: "steered" };
  } catch (error) {
    if (!request.fallback || !isStaleSteerError(error)) throw error;
    const held = await scheduler.create(
      {
        backend: request.backend,
        threadId: request.threadId,
        kind: "turn",
        origin: "desktop",
        scheduledFor: Date.now(),
        manualReleaseRequired: true,
        ...request.fallback,
      },
      { id: fallbackActionId(request) },
    );
    return {
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.expectedTurnId,
      disposition: "held",
      holdReason: STALE_STEER_HOLD_REASON,
      scheduledAction: held.action,
    };
  }
}

function fallbackActionId(request: SteerTurnRequest): string {
  const key = createHash("sha256")
    .update(`${request.backend}\0${request.threadId}\0${request.requestId}`)
    .digest("hex");
  return `scheduled-action:steer:${key}`;
}

function isStaleSteerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no active turn to steer")
    || (
      message.includes("expected active turn id")
      && message.includes("found")
    );
}
