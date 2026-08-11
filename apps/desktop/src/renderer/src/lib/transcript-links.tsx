import type {
  AppServerBackendKind,
  FederationInstanceId,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { ReactNode } from "react";
import { PullRequestLinkProvider } from "./pull-request-links";
import { ThreadLinkProvider } from "./thread-links";

export function TranscriptLinkProvider(props: {
  activeThread?: NavigationThreadSummary;
  children: ReactNode;
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
