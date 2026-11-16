import { useEffect, useMemo, useRef, useState } from "react";
import type { ReadMarkdownFileRequest } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; content: string }
  | { status: "error"; error: string };

/** One read per selected document, independent of transport availability. */
export function useFilePreviewRead(
  reader: DesktopApi["readMarkdownFile"],
  path: string | undefined,
  thread: ReadMarkdownFileRequest["thread"],
  federationTarget?: ReadMarkdownFileRequest["federationTarget"],
): LoadState {
  const source = useMemo(() => ({ path, thread, federationTarget }), [path, thread, federationTarget]);
  const readRef = useRef<{ source: typeof source; result: Promise<LoadState> } | undefined>(undefined);
  const [result, setResult] = useState<{ source: typeof source; state: LoadState }>();

  useEffect(() => {
    let cancelled = false;
    let read = readRef.current;
    if (read?.source !== source) {
      readRef.current = undefined;
      if (!path || !reader) {
        setResult({ source, state: path
          ? { status: "error", error: "File preview is unavailable." }
          : { status: "idle" } });
        return;
      }
      setResult({ source, state: { status: "loading" } });
      // Retain the promise as well as its result: replacing or temporarily
      // removing the API must neither cancel an admitted read nor repeat it.
      read = {
        source,
        result: readFile(reader, { path, thread, ...(federationTarget ? { federationTarget } : {}) }),
      };
      readRef.current = read;
    }
    void read.result.then((state) => {
      if (!cancelled) setResult({ source, state });
    });
    return () => {
      cancelled = true;
    };
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
