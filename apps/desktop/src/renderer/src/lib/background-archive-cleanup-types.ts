import type { ThreadLinkRef } from "@pwragent/shared";

export type BackgroundCleanupThread = { ref: ThreadLinkRef; title?: string };
export type BackgroundCleanupOutcome = {
  kind: "failed" | "kept" | "removed" | "absent";
  source: BackgroundCleanupThread;
  worktreePath?: string;
  reason: string;
  blockers: BackgroundCleanupThread[];
  blockerCount: number;
  textTruncated: boolean;
};
