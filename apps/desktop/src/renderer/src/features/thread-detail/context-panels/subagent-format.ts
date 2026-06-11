import type { ThreadSubAgentStatus } from "@pwragent/shared";
import type { RailChipTone } from "./RailStatusChip";

/** Maps a sub-agent status onto a shared status-chip tone. */
export function subAgentTone(status: ThreadSubAgentStatus): RailChipTone {
  switch (status) {
    case "running":
      return "active";
    case "success":
      return "ok";
    case "blocked":
      return "warning";
    case "failed":
    case "failure":
      return "error";
    case "pending":
    case "cancelled":
      return "neutral";
  }
}

/** Human label for a sub-agent status. */
export function subAgentStatusLabel(status: ThreadSubAgentStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "failed":
    case "failure":
      return "Failed";
    case "success":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Compact, locale-grouped token count (e.g. `303,488`). */
export function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

/**
 * USD for a sub-agent run cost. Sub-cent runs need three decimals to be
 * meaningful (e.g. `$0.047`), but we trim the thousandths digit when it
 * rounds to zero so `$0.05` doesn't read as `$0.050` (and `$0` as `$0.00`).
 * At ten cents and up, plain two-decimal cents.
 */
export function formatUsd(value: number): string {
  if (value >= 0.1) {
    return `$${value.toFixed(2)}`;
  }
  const precise = value.toFixed(3);
  return `$${precise.endsWith("0") ? value.toFixed(2) : precise}`;
}
