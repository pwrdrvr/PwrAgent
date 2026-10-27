import type { AppServerThreadMessageOrigin } from "@pwragent/shared";

/** Optional ancestry must not change the identity of an old peer's retry. */
export function withoutTurnAttribution(
  origin?: AppServerThreadMessageOrigin,
): AppServerThreadMessageOrigin | undefined {
  if (!origin?.sourceThread) return origin;
  const { turnId: _turnId, rootTurnId: _rootTurnId, ...sourceThread } = origin.sourceThread;
  return { ...origin, sourceThread };
}

/** Attribution only. Grouped work must have one exact invoking turn. */
export function delegatedTurnAttribution(
  origin?: AppServerThreadMessageOrigin,
  groupedOrigins?: (AppServerThreadMessageOrigin | undefined)[],
): { parentTurnId?: string; rootTurnId?: string } {
  const origins = groupedOrigins?.length ? groupedOrigins : [origin];
  const first = origins[0];
  const source = first?.sourceThread;
  if (first?.kind !== "agent" || source?.backend !== "codex" || !source.turnId) return {};
  if (origins.some((candidate) => candidate?.kind !== "agent"
    || candidate.sourceThread?.backend !== source.backend
    || candidate.sourceThread.threadId !== source.threadId
    || candidate.sourceThread.instanceId !== source.instanceId
    || candidate.sourceThread.turnId !== source.turnId
    || candidate.sourceThread.rootTurnId !== source.rootTurnId)) return {};
  return {
    parentTurnId: source.turnId,
    ...(source.rootTurnId ? { rootTurnId: source.rootTurnId } : {}),
  };
}
