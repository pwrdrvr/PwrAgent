import type { FederationTarget, NavigationThreadSummary } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "../features/notifications/AppNoticeToast";
import type { ResolvedThreadLink } from "./thread-links";

export type ThreadActionErrorContext = {
  threadLink?: ResolvedThreadLink;
  worktreePaths?: readonly string[];
};

type ActionThread = Pick<NavigationThreadSummary, "id" | "source"> & Partial<Pick<
  NavigationThreadSummary, "title" | "titleSource" | "federation" | "linkedDirectories" | "gitBranch"
>>;

/** Capture the action's identity before optimistic removal changes selection. */
export function threadActionErrorContext(thread: ActionThread, target?: FederationTarget): ThreadActionErrorContext {
  const owner = target ?? thread.federation?.ref.target;
  return {
    threadLink: {
      backend: thread.source,
      threadId: thread.id,
      title: thread.title?.trim() || thread.id,
      titleSource: thread.titleSource,
      ...(owner?.scope === "remote" ? { instanceId: owner.instanceId } : {}),
      instanceLabel: thread.federation?.instanceLabel,
      gitBranch: thread.gitBranch,
      linkedDirectories: thread.linkedDirectories,
    },
    worktreePaths: [...new Set((thread.linkedDirectories ?? []).flatMap((directory) =>
      directory.kind === "worktree" && directory.worktreePath ? [directory.worktreePath] : []))],
  };
}

/** The chip, stable id and checkout paths travel together into copied diagnostics. */
export function withThreadActionErrorContext(
  notice: AppNoticeToastNotice,
  context: ThreadActionErrorContext,
): AppNoticeToastNotice {
  const { threadLink } = context;
  const paths = [...new Set(context.worktreePaths ?? [])];
  if (!threadLink && paths.length === 0) return notice;
  const facts = [
    ...(threadLink ? [{ label: "Thread ID", value: threadLink.threadId }] : []),
    ...paths.map((value, index) => ({ label: paths.length === 1 ? "Worktree" : `Worktree ${index + 1}`, value })),
    ...(notice.facts ?? []),
  ];
  return {
    ...notice,
    ...(threadLink ? { threadLink, detail: notice.detail ?? threadLink.title } : {}),
    facts,
    copyText: [
      ...(threadLink ? [
        `Thread: ${threadLink.title}`,
        `Thread ID: ${threadLink.threadId}`,
        `Backend: ${threadLink.backend}`,
        ...(threadLink.instanceId ? [`Instance ID: ${threadLink.instanceId}`] : []),
      ] : []),
      ...paths.map((path) => `Worktree: ${path}`),
      "",
      notice.copyText ?? [notice.title, notice.message, notice.detail, ...(notice.facts ?? []).map((fact) => `${fact.label}: ${fact.value}`)].filter(Boolean).join("\n"),
    ].join("\n"),
  };
}
