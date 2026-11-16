import { useEffect, useMemo, useRef, useState } from "react";
import type { ReadMarkdownFileRequest } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; content: string }
  | { status: "error"; error: string };

/** Retain pending and successful reads; retry failures after transport changes. */
export function useFilePreviewRead(
  reader: DesktopApi["readMarkdownFile"],
  path: string | undefined,
  thread: ReadMarkdownFileRequest["thread"],
  federationTarget?: ReadMarkdownFileRequest["federationTarget"],
): LoadState {
  const source = useMemo(() => ({ path, thread, federationTarget }), [path, thread, federationTarget]);
  const readRef = useRef<{
    source: typeof source;
    reader: NonNullable<DesktopApi["readMarkdownFile"]>;
    retryOnError: boolean;
    result: Promise<LoadState>;
  } | undefined>(undefined);
  const [result, setResult] = useState<{ source: typeof source; state: LoadState }>();

  useEffect(() => {
    let cancelled = false;
    let read = readRef.current;
    if (read?.source === source && read.reader !== reader) {
      read.retryOnError = true;
    }
    if (read?.source !== source) {
      readRef.current = undefined;
      if (!path || !reader) {
        setResult({ source, state: path
          ? { status: "error", error: "File preview is unavailable." }
          : { status: "idle" } });
        return;
      }
      // Retain the promise as well as its result: replacing or temporarily
      // removing the API must neither cancel an admitted read nor repeat it.
      read = startRead(reader, path);
    }
    void settleRead(read);
    return () => {
      cancelled = true;
    };

    function startRead(activeReader: NonNullable<DesktopApi["readMarkdownFile"]>, selectedPath: string) {
      setResult({ source, state: { status: "loading" } });
      const nextRead = {
        source,
        reader: activeReader,
        retryOnError: false,
        result: readFile(activeReader, { path: selectedPath, thread, ...(federationTarget ? { federationTarget } : {}) }),
      };
      readRef.current = nextRead;
      return nextRead;
    }

    async function settleRead(currentRead: NonNullable<typeof readRef.current>) {
      let state = await currentRead.result;
      if (cancelled) return;
      // A disconnect can reject the old RPC after the reader has already
      // recovered. Admit one replacement for that transport change, even
      // if the restored reader is the same function. Its own failure waits
      // for another transport change rather than starting a retry loop.
      if (state.status === "error" && currentRead.retryOnError && reader && path) {
        state = await startRead(reader, path).result;
        if (cancelled) return;
      }
      setResult({ source, state });
    }
  }, [reader, path, thread, federationTarget, source]);

  // A new selection renders before its effect. Never expose the old file
  // under the new path, kind, thread or owner.
  return result?.source === source ? result.state : { status: path ? "loading" : "idle" };
}

async function readFile(
  reader: NonNullable<DesktopApi["readMarkdownFile"]>,
  request: ReadMarkdownFileRequest,
): Promise<LoadState> {
  try {
    const response = await reader(request);
    return response.error || response.content === undefined
      ? { status: "error", error: response.error ?? "File could not be read." }
      : { status: "loaded", content: response.content };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : "File could not be read." };
  }
}
