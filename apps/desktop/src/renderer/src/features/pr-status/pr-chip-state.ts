import type { PrSummary } from "@pwragent/shared";

export type PrChipDotState =
  | NonNullable<PrSummary["checkState"]>
  | "merged"
  | "closed";

export function resolveChipState(pr: PrSummary): PrChipDotState {
  const lifecycleState = resolveLifecycleState(pr);
  if (lifecycleState === "merged" || lifecycleState === "closed") {
    return lifecycleState;
  }
  return resolveCheckState(pr);
}

export function resolveLifecycleState(
  pr: PrSummary,
): NonNullable<PrSummary["lifecycleState"]> {
  if (pr.lifecycleState) {
    return pr.lifecycleState;
  }
  if (pr.state === "merged" || pr.state === "closed") {
    return pr.state;
  }
  return "open";
}

export function resolveCheckState(
  pr: PrSummary,
): NonNullable<PrSummary["checkState"]> {
  return pr.checkState ?? normalizeLegacyCheckState(pr.state);
}

function normalizeLegacyCheckState(
  state: PrSummary["state"],
): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

export function isPrStatusUnknown(pr: PrSummary): boolean {
  return (
    pr.state === "unknown"
    && !pr.checkState
    && !pr.lifecycleState
    && !pr.reviewState
    && !pr.mergeState
  );
}

export function prStatusLabel(pr: PrSummary): string {
  if (isPrStatusUnknown(pr)) {
    return "status unknown";
  }

  const lifecycleState = resolveLifecycleState(pr);
  const parts: string[] = [];
  if (lifecycleState === "merged") {
    return "merged";
  } else if (lifecycleState === "closed") {
    return "closed without merge";
  } else if (pr.reviewState === "draft") {
    parts.push("draft");
  } else {
    parts.push("ready for review");
  }

  if (pr.mergeState === "conflicting") {
    parts.push("merge conflict");
  }

  parts.push(checkStateTooltipLabel(resolveCheckState(pr)));
  return parts.join(" · ");
}

export function prPhaseLabel(pr: PrSummary): string | undefined {
  if (isPrStatusUnknown(pr)) {
    return undefined;
  }
  const lifecycleState = resolveLifecycleState(pr);
  if (lifecycleState !== "open") {
    return lifecycleState;
  }
  return pr.reviewState === "draft" ? "draft" : "open";
}

export function checkStateTooltipLabel(
  state: NonNullable<PrSummary["checkState"]>,
): string {
  switch (state) {
    case "passing":
      return "checks passing";
    case "failing":
      return "checks failing";
    case "pending":
      return "checks pending";
    case "unknown":
      return "status unknown";
  }
}
