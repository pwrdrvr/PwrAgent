import type { ThreadExecutionMode } from "@pwragent/shared";

export function formatExecutionModeLabel(mode?: ThreadExecutionMode): string {
  return mode === "full-access" ? "Full Access" : "Default Access";
}
