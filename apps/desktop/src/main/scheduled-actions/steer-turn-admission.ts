import { createHash } from "node:crypto";
import type {
  SteerTurnRequest,
  SteerTurnResponse,
  ScheduledThreadAction,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import type { ScheduledThreadActionService } from "./scheduled-thread-action-service.js";

const STALE_STEER_HOLD_REASON =
  "The active turn ended before this steering message could be delivered. Review the turn result, then retry this queued message.";

export async function admitSteerTurn(
  registry: Pick<DesktopBackendRegistry, "steerTurn">,
  scheduler: Pick<ScheduledThreadActionService, "create" | "get">,
  request: SteerTurnRequest,
): Promise<SteerTurnResponse> {
  const replayFallback = async (): Promise<SteerTurnResponse | undefined> => {
    if (!request.fallback) return undefined;
    const existing = scheduler.get(fallbackActionId(request));
    if (!existing) return undefined;
    // Validate the original payload through create's idempotency check, but
    // retain the admission policy the owner already chose for this request.
    const replay = await scheduler.create({
      backend: request.backend, threadId: request.threadId, kind: "turn", origin: "desktop",
      scheduledFor: existing.scheduledFor,
      manualReleaseRequired: existing.manualReleaseRequired,
      ...request.fallback,
    }, { id: existing.id });
    return fallbackResponse(request, replay.action);
  };
  const replay = await replayFallback();
  if (replay) return replay;
  try {
    const response = await registry.steerTurn(request);
    return response.disposition
      ? response
      : { ...response, disposition: "steered" };
  } catch (error) {
    // Another attempt can admit the fallback while the provider call waits.
    const replay = await replayFallback();
    if (replay) return replay;
    // This owner-side refusal happens before provider delivery. A native
    // review cannot take the steer, but its parent can queue a normal turn.
    const nativeReview = request.backend === "codex"
      && error instanceof Error
      && error.message === "Native review steering is unsupported; queue a follow-up instead.";
    if (!request.fallback || (!nativeReview && !isStaleSteerError(error))) throw error;
    const fallback = await scheduler.create(
      {
        backend: request.backend,
        threadId: request.threadId,
        kind: "turn",
        origin: "desktop",
        scheduledFor: Date.now(),
        ...(!nativeReview ? { manualReleaseRequired: true } : {}),
        ...request.fallback,
      },
      { id: fallbackActionId(request) },
    );
    return fallbackResponse(request, fallback.action);
  }
}

function fallbackResponse(request: SteerTurnRequest, action: ScheduledThreadAction): SteerTurnResponse {
  return {
    backend: request.backend,
    threadId: request.threadId,
    turnId: action.status === "started" ? action.turnId ?? request.expectedTurnId : request.expectedTurnId,
    ...(action.status === "started"
      ? { disposition: "started" as const }
      : action.manualReleaseRequired
        ? { disposition: "held" as const, holdReason: STALE_STEER_HOLD_REASON }
        : { disposition: "scheduled" as const }),
    ...(!action.manualReleaseRequired ? { fallbackReason: "native-review" as const } : {}),
    scheduledAction: action,
  };
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
