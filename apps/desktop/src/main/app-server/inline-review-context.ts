import type { AgentEvent, AppServerReviewContext, AppServerThreadReviewEntry } from "@pwragent/shared";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";

/** A captured scope card, not a sub-agent or a second turn lifecycle. */
export async function persistInlineReviewContext(params: {
  store: Pick<OverlayStoreLike, "upsertManagedReviewEntry">;
  emit: (event: AgentEvent) => Promise<void>;
  threadId: string;
  turnId: string;
  context: AppServerReviewContext;
  reviewer: NonNullable<AppServerThreadReviewEntry["reviewer"]>;
}): Promise<void> {
  const snapshot = params.context.pullRequestSnapshot;
  if (!snapshot) throw new Error("Inline PR review is missing its captured scope.");
  const label = `Review ${snapshot.pullRequest.org}/${snapshot.pullRequest.repo}#${snapshot.pullRequest.number} at ${snapshot.headCommit.slice(0, 10)}`;
  const entry: AppServerThreadReviewEntry = {
    type: "review",
    id: `inline-review:${params.turnId}:context`,
    createdAt: Date.now(),
    review: label,
    displayText: label,
    context: params.context,
    reviewer: params.reviewer,
  };
  await params.store.upsertManagedReviewEntry({ backend: "codex", threadId: params.threadId, entry });
  // No turn metadata: this card records the requested scope. The ordinary
  // parent turn owns progress, completion, and the prose review findings.
  await params.emit({
    backend: "codex",
    notification: {
      method: "item/completed",
      params: {
        threadId: params.threadId,
        item: {
          id: entry.id, type: "enteredReviewMode", review: label,
          createdAt: entry.createdAt,
          data: { context: entry.context, reviewer: entry.reviewer },
        },
      },
    },
  });
}
