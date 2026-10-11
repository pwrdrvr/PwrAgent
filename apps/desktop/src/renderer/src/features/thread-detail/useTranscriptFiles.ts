import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  transcriptFileReference,
  type MarkdownFileViewerContext,
  type ResolvedTranscriptFile,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useMarkdownFileSource } from "./useMarkdownFileSource";

type Files = Map<string, ResolvedTranscriptFile>;
const EMPTY_FILES: Files = new Map();
export const TranscriptFileRegistrationContext = createContext<(reference: string) => void>(() => undefined);

/** Existing Markdown code nodes supply candidates; never parse the growing message again. */
export function useTranscriptFileReference(text: string, enabled: boolean): void {
  const register = useContext(TranscriptFileRegistrationContext);
  const reference = useMemo(() => enabled && transcriptFileReference(text) ? text : undefined, [text, enabled]);
  useEffect(() => {
    if (reference) register(reference);
  }, [reference, register]);
}

export function useTranscriptFiles(
  desktopApi: Pick<DesktopApi, "resolveTranscriptFiles"> | undefined,
  context: MarkdownFileViewerContext | undefined,
) {
  const resolveFiles = desktopApi?.resolveTranscriptFiles;
  const { thread, federationTarget } = useMarkdownFileSource(context);
  const projectPath = context?.projectPath;
  const hydrator = useMemo(() => {
    const seen = new Set<string>();
    const pending = new Set<string>();
    const files: Files = new Map();
    let timer: number | undefined;
    let publish: ((files: Files) => void) | undefined;
    const schedule = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!resolveFiles || !publish || !pending.size) return;
        const references = [...pending];
        pending.clear();
        void resolveFiles({ references, thread, federationTarget, projectPath }).then((result) => {
          for (const file of result.files) files.set(file.reference, file);
          publish?.(new Map(files));
        }).catch(() => {
          // An offline/older owner leaves code literal; never fall back to local stat.
        });
      }, 120);
    };
    return {
      register: (reference: string): void => {
        if (!resolveFiles || !(thread || projectPath) || seen.has(reference) || seen.size >= 128) return;
        seen.add(reference);
        pending.add(reference);
        schedule();
      },
      subscribe: (listener: (files: Files) => void): (() => void) => {
        publish = listener;
        // React StrictMode may clear the first timer before re-subscribing.
        if (pending.size) schedule();
        return () => {
          publish = undefined;
          if (timer !== undefined) window.clearTimeout(timer);
          timer = undefined;
        };
      },
    };
  }, [resolveFiles, thread, federationTarget, projectPath]);
  const [resolved, setResolved] = useState<{ hydrator: typeof hydrator; files: Files }>();
  useEffect(() => hydrator.subscribe((files) => setResolved({ hydrator, files })), [hydrator]);
  return {
    files: resolved?.hydrator === hydrator ? resolved.files : EMPTY_FILES,
    register: hydrator.register,
  };
}
