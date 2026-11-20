/**
 * A turn whose output the provider is holding for a safety review. It is a
 * status, not a transcript row: it shows only while that turn runs and ends
 * when the provider ends the hold, model text starts streaming, or the turn
 * ends. A faster-model hint never appears here; it changes nothing.
 */
export type SafetyBufferingState = {
  turnId: string;
  model: string;
};

export const SAFETY_REVIEW_STATUS_TEXT = "Safety review in progress";

type SessionWithSafetyBuffering = {
  activeTurnId?: string;
  backendReportedActive?: boolean;
  safetyBuffering?: SafetyBufferingState;
};

type LiveNotification = { method: string; params: unknown };

export function transitionSafetyBuffering<T extends SessionWithSafetyBuffering>(
  session: T,
  notification: LiveNotification,
): T {
  const params = typeof notification.params === "object" && notification.params !== null
    ? notification.params as Record<string, unknown>
    : {};
  const turnId = typeof params.turnId === "string" && params.turnId ? params.turnId : undefined;
  const current = session.safetyBuffering;

  if (notification.method === "turn/safetyBuffering/updated") {
    if (!turnId || typeof params.buffering !== "boolean") return session;
    if (params.buffering) {
      const model = typeof params.model === "string" ? params.model : "";
      if (current?.turnId === turnId && current.model === model) return session;
      return { ...session, safetyBuffering: { turnId, model } };
    }
    return current?.turnId === turnId ? withoutSafetyBuffering(session) : session;
  }

  if (!current) return session;
  const sameTurn = !turnId || turnId === current.turnId;
  switch (notification.method) {
    case "item/agentMessage/delta":
      return sameTurn && typeof params.delta === "string" && params.delta !== ""
        ? withoutSafetyBuffering(session)
        : session;
    case "turn/completed":
    case "turn/failed":
    case "turn/cancelled":
      return sameTurn ? withoutSafetyBuffering(session) : session;
    case "turn/started":
      return turnId && turnId !== current.turnId ? withoutSafetyBuffering(session) : session;
    default:
      return session;
  }
}

/** The status line for a held turn, or undefined when nothing is held. */
export function safetyReviewStatusText(
  session: SessionWithSafetyBuffering,
): string | undefined {
  return session.safetyBuffering && (session.activeTurnId || session.backendReportedActive)
    ? SAFETY_REVIEW_STATUS_TEXT
    : undefined;
}

function withoutSafetyBuffering<T extends SessionWithSafetyBuffering>(session: T): T {
  const next = { ...session };
  delete next.safetyBuffering;
  return next;
}
