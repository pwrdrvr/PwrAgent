import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadPullRequestMergeTarget,
} from "@pwragent/shared/contracts/navigation";
import { resolvePullRequestMergeRoute } from "@pwragent/shared/pull-request-merge-offer";
import type { ThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
import type { DesktopApi } from "../../lib/desktop-api";
import { isFederationViewerWindow } from "../../lib/federation-window";
import { ipcErrorMessage } from "../../lib/open-path-failure";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";

/**
 * What a sidebar PR card needs to merge its PR. The merge runs in main and
 * may outlive the card (the pointer leaves, the card closes), so the result
 * is reported here, as a toast, not by the card.
 */
export type PullRequestMergeService = {
  api: DesktopApi;
  /** Resolves `true` once the PR merged or joined its queue. */
  merge: (request: {
    thread: ThreadPullRequestMergeTarget;
    pr: PrSummary;
    method: ThreadTodoMergeMethod;
    rememberMethod: boolean;
    /** The open lower layers of the PR's GitHub stack the operator chose to merge with it. */
    mergeOpenLayersBelow?: number[];
  }) => Promise<boolean>;
};

const PullRequestMergeContext = createContext<PullRequestMergeService | undefined>(undefined);

/**
 * The thread a PR card merges from, or undefined when it offers no merge. A
 * peer's thread names its owner, which runs the merge; see
 * `resolvePullRequestMergeRoute`.
 */
export function threadPullRequestMergeTarget(
  thread: Pick<NavigationThreadSummary, "source" | "id" | "federation">,
): ThreadPullRequestMergeTarget | undefined {
  const route = resolvePullRequestMergeRoute({
    ...(thread.federation ? { federation: thread.federation } : {}),
    viewerWindow: isFederationViewerWindow(),
  });
  if (route.kind === "none") return undefined;
  return {
    backend: thread.source,
    threadId: thread.id,
    ...(route.kind === "owner" ? { federationTarget: route.target } : {}),
  };
}

/** Undefined where the desktop API cannot merge. */
export function usePullRequestMergeService(): PullRequestMergeService | undefined {
  return useContext(PullRequestMergeContext);
}

export function PullRequestMergeProvider(props: {
  /** Omitted where PR cards must not merge. */
  desktopApi: DesktopApi | undefined;
  showNotice: (notice: AppNoticeToastNotice) => void;
  children: ReactNode;
}) {
  const { desktopApi, showNotice } = props;
  const merge = useCallback<PullRequestMergeService["merge"]>(async ({ thread, pr, method, rememberMethod, mergeOpenLayersBelow }) => {
    const label = `#${pr.number}`;
    const context = `${pr.org}/${pr.repo}${pr.title ? ` · ${pr.title}` : ""}`;
    try {
      if (!desktopApi?.mergeThreadPullRequest) throw new Error("Merging is not available in this window.");
      const result = await desktopApi.mergeThreadPullRequest({
        ...thread, url: pr.url, method, rememberMethod,
        // A peer's owner takes no choice of lower layers; only a local merge sends one.
        ...(mergeOpenLayersBelow?.length && thread.federationTarget?.scope !== "remote" ? { mergeOpenLayersBelow } : {}),
      });
      showNotice({
        id: `pr-card-merge:${pr.url}`,
        tone: "success",
        autoDismiss: true,
        title: result.summary,
        message: context,
      });
      return true;
    } catch (error) {
      showNotice({
        id: `pr-card-merge:${pr.url}`,
        tone: "error",
        autoDismiss: false,
        title: `Could not merge ${label}`,
        message: ipcErrorMessage(error),
        detail: context,
      });
      return false;
    }
  }, [desktopApi, showNotice]);
  const value = useMemo(() => desktopApi?.mergeThreadPullRequest && desktopApi.readThreadPullRequestMerge
    ? { api: desktopApi, merge }
    : undefined, [desktopApi, merge]);
  return (
    <PullRequestMergeContext.Provider value={value}>
      {props.children}
    </PullRequestMergeContext.Provider>
  );
}
