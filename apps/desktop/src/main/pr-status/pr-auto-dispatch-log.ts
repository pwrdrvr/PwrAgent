import type { PrAutoDispatchOutcome } from "./pr-auto-dispatch";

type DispatchLogger = {
  debug(message: string, details: Record<string, unknown>): void;
  info(message: string, details: Record<string, unknown>): void;
  warn(message: string, details: Record<string, unknown>): void;
};

export function logPrAutoDispatchOutcome(
  logger: DispatchLogger,
  prKey: string,
  outcome: PrAutoDispatchOutcome,
): void {
  // Snapshots are observed on every poll, including unchanged PRs. Keep
  // routine eligibility/dedupe decisions out of the operator's INFO log.
  const level = outcome.status === "failed"
    ? "warn"
    : outcome.status === "scheduled" || outcome.status === "dispatched"
      ? "info"
      : "debug";
  logger[level]("pr auto dispatch", { prKey, ...outcome });
}
