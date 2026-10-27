import type { AppServerThreadMessageOrigin } from "@pwragent/shared";

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
