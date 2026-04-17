import type { ThreadExecutionMode } from "@pwragnt/shared";

export function formatExecutionModeLabel(mode?: ThreadExecutionMode): string {
  return mode === "full-access" ? "Full Access" : "Default Access";
}
