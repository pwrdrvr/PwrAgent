import { buildThreadMarkdownLink } from "@pwragent/shared/contracts/thread-link";
import { fromMarkdown } from "mdast-util-from-markdown";
import { useEffect, useState } from "react";
import { getDesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { readLegacyComposerThreadRow } from "../../lib/thread-link-rows";
import { formatHashReferenceThreadLabel } from "../../lib/hash-references";
import {
  resolveThreadHref,
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

type ComposerThreadReference = {
  start: number;
  end: number;
  link: ResolvedThreadLink;
  fallbackLabel: string;
};

export function readComposerThreadReference(
  node: MarkdownNode,
  text: string,
  links: ThreadLinkContextValue | undefined,
): ComposerThreadReference | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (node.type !== "link" || !node.url || start === undefined || end === undefined) return undefined;
  const link = resolveThreadHref(node.url, links);
  if (!link) return undefined;

  // Keep the copied name while the owner is off-page or hasn't named the
  // thread yet. The link's label never participates in identity resolution.
  const labelEnd = text.lastIndexOf("](", end - 1);
  const fallback = text[start] === "[" && labelEnd > start && labelEnd < end
    ? text.slice(start + 1, labelEnd).replace(/\\([\\[\]])/g, "$1")
    : "";
  return { start, end, link, fallbackLabel: fallback };
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
        const link = resolveThreadHref(href, links);
        if (link) references.push({ start: start + match.index, end: start + match.index + href.length,
          link, fallbackLabel: "" });
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

function readLegacyComposerLink(link: ResolvedThreadLink): Promise<ResolvedThreadLink | undefined> | undefined {
  const api = getDesktopApi();
  if (link.instanceId || link.inThreadList || link.title || !api?.jumpSearchRemoteThreads
    || readRendererFederationTarget()) return undefined;
  return readLegacyComposerThreadRow(api, link).then((row) => {
    const target = row?.federation?.ref.target;
    if (!row || target?.scope !== "remote") return undefined;
    return {
      ...link,
      instanceId: target.instanceId,
      instanceLabel: row.federation?.instanceLabel,
      title: row.title,
      titleSource: row.titleSource,
      gitBranch: row.gitBranch,
      linkedDirectories: row.linkedDirectories,
    };
  }).catch(() => undefined);
}

export function useComposerThreadReference(link: ResolvedThreadLink): ResolvedThreadLink {
  const liveLink = useLiveThreadLink(link);
  const [legacy, setLegacy] = useState<{ source: ResolvedThreadLink; link: ResolvedThreadLink }>();
  useEffect(() => {
    let current = true;
    void readLegacyComposerLink(liveLink)?.then((result) => {
      if (current && result) setLegacy({ source: liveLink, link: result });
    });
    return () => { current = false; };
  }, [liveLink]);
  return legacy?.source === liveLink ? legacy.link : liveLink;
}

export function resolveComposerThreadDestinations(
  text: string,
  links: ThreadLinkContextValue | undefined,
): string | Promise<string> {
  const references = findComposerThreadReferences(text, links);
  const reads = references.map(({ link }) => readLegacyComposerLink(link));
  if (!reads.some(Boolean)) return text;
  return Promise.all(reads).then((resolved) => {
    let output = "";
    let cursor = 0;
    references.forEach(({ start, end, link }, index) => {
      const target = resolved[index];
      if (!target) return;
      // The local row may have appeared while the peer read was outstanding.
      const local = links?.resolve({ backend: link.backend, threadId: link.threadId });
      if (local?.inThreadList || local?.title) return;
      output += text.slice(cursor, start) + buildThreadMarkdownLink({ ...target, title: composerThreadLabel(target) });
      cursor = end;
    });
    return output + text.slice(cursor);
  });
}
