import type { PrSummary, ThreadTodo } from "@pwragent/shared";
import { threadTodoActionProject } from "@pwragent/shared";
import { useMemo } from "react";
import {
  parsePullRequestUrl,
  useOptionalLivePullRequest,
  useThreadPullRequestNumber,
} from "../../lib/pull-request-links";
import { PullRequestLinkChip } from "../pr-status/PullRequestLinkChip";

/**
 * A merge card's pull request as the live PR chip: status dot, status card
 * on hover, click to open. The action stores what `gh pr merge` takes, a
 * number or a URL. A URL names its PR; a number resolves against the PRs
 * attached to the raising thread on its owner, then to the card's project
 * repository using metadata from that owner.
 * When nothing resolves, the plain `#123` text stays: a guessed chip could
 * open another repository's PR.
 */
export function TodoPullRequestChip(props: {
  todo: ThreadTodo;
  pullRequest: string;
}) {
  const { todo, pullRequest } = props;
  const pr = useTodoPullRequest(todo, pullRequest);
  if (pr) {
    return <PullRequestLinkChip pr={pr} />;
  }
  return <>{/^\d+$/.test(pullRequest) ? `#${pullRequest}` : pullRequest}</>;
}

/**
 * The merge card's pull request, resolved as its chip resolves it. Undefined
 * when nothing resolves.
 */
export function useTodoPullRequest(todo: ThreadTodo, pullRequest: string | undefined): PrSummary | undefined {
  const isNumber = pullRequest !== undefined && /^\d+$/.test(pullRequest);
  const fromUrl = useMemo(
    () => pullRequest === undefined || isNumber ? undefined : parsePullRequestUrl(pullRequest),
    [isNumber, pullRequest],
  );
  const fromThread = useThreadPullRequestNumber(isNumber
    ? {
        backend: todo.backend,
        threadId: todo.threadId,
        number: Number(pullRequest),
        projectPath: threadTodoActionProject(todo)?.path,
        federationTarget: todo.federationTarget,
      }
    : undefined);
  return fromUrl ?? fromThread;
}

/** The merge card's pull request with its live status, for its queue state. */
export function useTodoLivePullRequest(todo: ThreadTodo, pullRequest: string | undefined): PrSummary | undefined {
  return useOptionalLivePullRequest(useTodoPullRequest(todo, pullRequest));
}
