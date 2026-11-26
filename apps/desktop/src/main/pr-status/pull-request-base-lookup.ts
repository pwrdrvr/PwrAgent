import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";

/**
 * The base branch this owner last read from the forge for one of a thread's
 * pull requests, named by URL or number (`#7`, `7`). The app-server
 * service, which owns PR status, installs it; merge paths outside that
 * service read it to apply a never-merge project's branch list
 * (`mergeBranches`). Undefined when nothing is installed or the
 * PR's status has not been read, which a never-merge project treats as a
 * branch it does not list.
 */
type PullRequestBaseThread = { backend: AppServerBackendKind; threadId: string };
type PullRequestBaseLookup = (thread: PullRequestBaseThread, pullRequest: string) => string | undefined;

let lookup: PullRequestBaseLookup | undefined;

export function setPullRequestBaseLookup(next: PullRequestBaseLookup | undefined): void {
  lookup = next;
}

export function readPullRequestBase(thread: PullRequestBaseThread, pullRequest: string): string | undefined {
  return lookup?.(thread, pullRequest);
}
