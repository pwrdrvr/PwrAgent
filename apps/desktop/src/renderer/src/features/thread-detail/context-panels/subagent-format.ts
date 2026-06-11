import type { ThreadSubAgentStatus } from "@pwragent/shared";

export type SubAgentTone = "active" | "done" | "warn" | "idle";

/** Maps a sub-agent status onto the dot/label color tone. */
export function subAgentTone(status: ThreadSubAgentStatus): SubAgentTone {
  switch (status) {
    case "running":
      return "active";
    case "success":
      return "done";
    case "blocked":
    case "failed":
    case "failure":
    case "cancelled":
      return "warn";
    case "pending":
      return "idle";
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
export function formatTokenCount(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.toLocaleString();
}

/** Two-decimal USD, e.g. `$0.047` → `$0.05` is too lossy, so keep 3 dp. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(3)}`;
}
