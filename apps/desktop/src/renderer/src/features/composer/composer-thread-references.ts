import { buildThreadMarkdownLink, parseThreadUrl, type ThreadLinkRef } from "@pwragent/shared/contracts/thread-link";
import { fromMarkdown } from "mdast-util-from-markdown";
import { useEffect, useState } from "react";
import { getDesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { readThreadInfoRow } from "../../lib/thread-link-rows";
import { formatHashReferenceThreadLabel } from "../../lib/hash-references";
import {
  useThreadLinks,
  useLiveThreadLink,
  type ResolvedThreadLink,
  type ThreadLinkContextValue,
} from "../../lib/thread-links";

type MarkdownNode = {
  type: string;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

type ComposerThreadDestination = { link: ResolvedThreadLink; ref: ThreadLinkRef };

type ComposerThreadReference = ComposerThreadDestination & {
  start: number;
  end: number;
  fallbackLabel: string;
};

export function resolveComposerThreadHref(
  href: string,
  links: ThreadLinkContextValue | undefined,
): ComposerThreadDestination | undefined {
  const ref = parseThreadUrl(href);
  const link = ref && links?.resolve(ref);
  if (!ref || !link) return undefined;
  // Metadata may normalize the viewer's explicit owner away. It must not
  // replace that identity with a peer or supply a different message anchor.
  if (ref.instanceId && link.instanceId && ref.instanceId !== link.instanceId) return undefined;
  return { link, ref };
}

export function readComposerThreadReference(
  node: MarkdownNode,
  text: string,
  links: ThreadLinkContextValue | undefined,
): ComposerThreadReference | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (node.type !== "link" || !node.url || start === undefined || end === undefined) return undefined;
  const destination = resolveComposerThreadHref(node.url, links);
  if (!destination) return undefined;

  // Keep the copied name while the owner is off-page or hasn't named the
  // thread yet. The link's label never participates in identity resolution.
  const labelEnd = text.lastIndexOf("](", end - 1);
  const fallback = text[start] === "[" && labelEnd > start && labelEnd < end
    ? text.slice(start + 1, labelEnd).replace(/\\([\\[\]])/g, "$1")
    : "";
  return { ...destination, start, end, fallbackLabel: fallback };
}

export function findComposerThreadReferences(
  text: string,
  links: ThreadLinkContextValue | undefined,
): ComposerThreadReference[] {
  if (!links || !/pwragent:\/\/thread\//i.test(text)) return [];
  const references: ComposerThreadReference[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "link") {
      const reference = readComposerThreadReference(node, text, links);
      if (reference) references.push(reference);
      return;
    }
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const match of text.slice(start, end).matchAll(/(?<![\w/\\])pwragent:\/\/thread\/[^\s()<>[\]"'`]+/gi)) {
        const href = match[0].replace(/[.,;!]+$/, "");
        const destination = resolveComposerThreadHref(href, links);
        if (destination) references.push({
          ...destination, start: start + match.index, end: start + match.index + href.length, fallbackLabel: "",
        });
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(text));
  return references;
}

export function composerThreadLabel(link: ResolvedThreadLink, fallback?: string): string {
  return formatHashReferenceThreadLabel({
    id: link.threadId,
    title: !link.title || (link.titleSource === "fallback" && fallback !== link.threadId)
      ? fallback || link.title
      : link.title,
  });
}

function cachedPeerOwner(link: ResolvedThreadLink, links: ThreadLinkContextValue) {
  const matches = links.readLoadedThreads?.().filter((row) => row.id === link.threadId
    && row.source === link.backend && row.federation?.ref.target.scope === "remote");
  const target = matches?.length === 1 ? matches[0]?.federation?.ref.target : undefined;
  return target?.scope === "remote" ? target.instanceId : undefined;
}

function recoverComposerThreadOwner(
  { link, ref }: ComposerThreadDestination,
  links: ThreadLinkContextValue,
): Promise<ResolvedThreadLink | undefined> | undefined {
  const api = getDesktopApi();
  if (ref.instanceId || ref.profile || link.instanceId || !api?.getNavigationQueryPage
    || readRendererFederationTarget() || !cachedPeerOwner(link, links)) return undefined;
  const local = links.getSnapshot(link);
  if (local.inThreadList || local.title) return undefined;

  // An old copy can use a peer row the viewer already holds, after the local
  // owner confirms a miss. Draft text never drives a federation-wide search.
  return readThreadInfoRow(api, link, undefined).then((row) => {
    const current = links.getSnapshot(link);
    if (row || current.inThreadList || current.title) return undefined;
    const instanceId = cachedPeerOwner(link, links);
    return instanceId ? links.resolve({ ...ref, backend: link.backend, instanceId }) : undefined;
  }).catch(() => undefined);
}

export function useComposerThreadReference(
  link: ResolvedThreadLink,
  ref: ThreadLinkRef,
): ResolvedThreadLink {
  const links = useThreadLinks();
  const [recovered, setRecovered] = useState<{
    source: ResolvedThreadLink;
    context: ThreadLinkContextValue;
    link: ResolvedThreadLink;
  }>();
  useEffect(() => {
    if (!links) return;
    let current = true;
    void recoverComposerThreadOwner({ link, ref }, links)?.then((result) => {
      if (current && result) setRecovered({ source: link, context: links, link: result });
    });
    return () => { current = false; };
  }, [link, links, ref]);
  return useLiveThreadLink(
    recovered?.source === link && recovered.context === links ? recovered.link : link,
  );
}

export function resolveComposerThreadDestinations(
  text: string,
  links: ThreadLinkContextValue | undefined,
): string | Promise<string> {
  if (!links) return text;
  const references = findComposerThreadReferences(text, links);
  const reads = references.map((reference) => recoverComposerThreadOwner(reference, links));
  const rewrite = (resolved: (ResolvedThreadLink | undefined)[]): string => {
    let output = "";
    let cursor = 0;
    references.forEach(({ start, end, link, ref, fallbackLabel }, index) => {
      const recovered = resolved[index];
      const target = links.getSnapshot(recovered ?? link);
      const title = composerThreadLabel(target, fallbackLabel);
      if (!recovered && (!target.title || title === fallbackLabel)) return;
      output += text.slice(cursor, start) + buildThreadMarkdownLink({
        ...ref,
        backend: target.backend,
        instanceId: ref.instanceId ?? target.instanceId,
        title,
      });
      cursor = end;
    });
    return output + text.slice(cursor);
  };
  return reads.some(Boolean) ? Promise.all(reads).then(rewrite) : rewrite([]);
}
