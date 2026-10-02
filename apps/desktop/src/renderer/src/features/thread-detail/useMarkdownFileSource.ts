import { useMemo } from "react";
import type { MarkdownFileViewerContext } from "@pwragent/shared";

/** Metadata refreshes must not change the identity of the document read. */
export function useMarkdownFileSource(context: MarkdownFileViewerContext | undefined) {
  const backend = context?.thread?.backend;
  const threadId = context?.thread?.threadId;
  const scope = context?.federationTarget?.scope;
  const instanceId = context?.federationTarget?.scope === "remote"
    ? context.federationTarget.instanceId
    : undefined;
  const thread = useMemo(() => backend !== undefined && threadId !== undefined
    ? { backend, threadId }
    : undefined, [backend, threadId]);
  const federationTarget = useMemo<MarkdownFileViewerContext["federationTarget"]>(
    () => scope === "remote" && instanceId !== undefined
      ? { scope, instanceId }
      : scope === "local" ? { scope } : undefined,
    [scope, instanceId],
  );
  return { thread, federationTarget };
}
