import type { ThreadTodo } from "@pwragent/shared";
import { threadTodoActionProject } from "@pwragent/shared";
import { useMemo } from "react";
import {
  parsePullRequestUrl,
  useThreadPullRequestNumber,
} from "../../lib/pull-request-links";
import { PullRequestLinkChip } from "../pr-status/PullRequestLinkChip";

/**
 * A merge card's pull request as the live PR chip: status dot, status card
 * on hover, click to open. The action stores what `gh pr merge` takes, a
 * number or a URL. A URL names its PR; a number resolves against the PRs
 * attached to the raising thread, then to threads in the card's project.
 * When nothing resolves, the plain `#123` text stays: a guessed chip could
 * open another repository's PR.
 */
export function TodoPullRequestChip(props: {
  todo: ThreadTodo;
  pullRequest: string;
}) {
  const { todo, pullRequest } = props;
  const isNumber = /^\d+$/.test(pullRequest);
  const fromUrl = useMemo(
    () => isNumber ? undefined : parsePullRequestUrl(pullRequest),
    [isNumber, pullRequest],
  );
  const fromThread = useThreadPullRequestNumber(isNumber
    ? {
        backend: todo.backend,
        threadId: todo.threadId,
        number: Number(pullRequest),
        projectPath: threadTodoActionProject(todo)?.path,
      }
    : undefined);
  const pr = fromUrl ?? fromThread;
  if (pr) {
    return <PullRequestLinkChip pr={pr} />;
  }
  return <>{isNumber ? `#${pullRequest}` : pullRequest}</>;
}
