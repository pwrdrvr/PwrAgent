import type {
  AppServerBackendKind,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { ReactNode } from "react";
import { PullRequestLinkProvider } from "./pull-request-links";
import { ThreadLinkProvider } from "./thread-links";

export function TranscriptLinkProvider(props: {
  activeThread?: NavigationThreadSummary;
  children: ReactNode;
  onShowThread: (request: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => void;
  threads: NavigationThreadSummary[];
}) {
  return (
    <ThreadLinkProvider
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
