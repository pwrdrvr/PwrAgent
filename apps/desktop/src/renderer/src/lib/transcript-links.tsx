import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationInstanceId } from "@pwragent/shared/contracts/federation";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ReactNode } from "react";
import { PullRequestLinkProvider } from "./pull-request-links";
import { ThreadLinkProvider } from "./thread-links";

export function TranscriptLinkProvider(props: {
  activeThread?: NavigationThreadSummary;
  children: ReactNode;
  localInstanceId?: FederationInstanceId;
  onOpenRemoteViewer?: (request: {
    backend: AppServerBackendKind;
    instanceId: FederationInstanceId;
    instanceLabel?: string;
    threadId: string;
  }) => void;
  onShowThread: (request: {
    backend: AppServerBackendKind;
    instanceId?: FederationInstanceId;
    instanceLabel?: string;
    inThreadList?: boolean;
    threadId: string;
  }) => void;
  threads: NavigationThreadSummary[];
}) {
  return (
    <ThreadLinkProvider
      localInstanceId={props.localInstanceId}
      onOpenRemoteViewer={props.onOpenRemoteViewer}
      onShowThread={props.onShowThread}
      threads={props.threads}
    >
      <PullRequestLinkProvider
        activeThread={props.activeThread}
        threads={props.threads}
      >
        {props.children}
      </PullRequestLinkProvider>
    </ThreadLinkProvider>
  );
}
