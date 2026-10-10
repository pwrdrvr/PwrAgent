import { fromMarkdown } from "mdast-util-from-markdown";
import { useEffect, useMemo, useState } from "react";
import {
  transcriptFileReference,
  type MarkdownFileViewerContext,
  type ResolvedTranscriptFile,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useMarkdownFileSource } from "./useMarkdownFileSource";

type Node = { type: string; value?: string; children?: Node[] };
const EMPTY_FILES = new Map<string, ResolvedTranscriptFile>();

export function inlineFileReferences(markdown: string): string[] {
  if (!markdown.includes("`")) return [];
  const references = new Set<string>();
  const visit = (node: Node): void => {
    if (["link", "linkReference", "code", "html"].includes(node.type)) return;
    if (node.type === "inlineCode" && node.value && transcriptFileReference(node.value)) {
      if (references.size < 128) references.add(node.value);
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  return [...references];
}

export function useTranscriptFiles(
  markdown: string,
  desktopApi: Pick<DesktopApi, "resolveTranscriptFiles"> | undefined,
  context: MarkdownFileViewerContext | undefined,
): Map<string, ResolvedTranscriptFile> {
  const resolveFiles = desktopApi?.resolveTranscriptFiles;
  const { thread, federationTarget } = useMarkdownFileSource(context);
  const projectPath = context?.projectPath;
  const canResolve = Boolean(resolveFiles && (thread || projectPath));
  const identity = JSON.stringify([thread, federationTarget, projectPath]);
  const referencesKey = useMemo(() => JSON.stringify(canResolve
    ? inlineFileReferences(markdown)
    : []), [markdown, canResolve]);
  const [resolved, setResolved] = useState<{
    identity: string;
    files: Map<string, ResolvedTranscriptFile>;
  }>();

  useEffect(() => {
    const references = JSON.parse(referencesKey) as string[];
    if (!resolveFiles || !references.length) return;
    let cancelled = false;
    // Coalesce paths introduced together while the model streams Markdown.
    const timer = window.setTimeout(() => {
      void resolveFiles({ references, thread, federationTarget, projectPath }).then((result) => {
        if (!cancelled) {
          setResolved({ identity, files: new Map(result.files.map((file) => [file.reference, file])) });
        }
      }).catch(() => {
        if (!cancelled) setResolved({ identity, files: EMPTY_FILES });
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resolveFiles, referencesKey, thread, federationTarget, projectPath, identity]);

  return resolved?.identity === identity && canResolve ? resolved.files : EMPTY_FILES;
}
