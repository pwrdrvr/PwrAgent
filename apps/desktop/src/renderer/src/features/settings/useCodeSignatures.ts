import { useEffect, useState } from "react";
import type { DesktopCodeSignature } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * Reads code signatures for the paths a settings pane is showing.
 *
 * Deliberately not part of discovery. Discovery already spawns a
 * `--version` probe per candidate during startup, and folding signature
 * probes in would put that cost on every launch whether or not anyone
 * opens Settings. The main process caches each answer on the file's
 * identity, so re-opening a pane re-reads nothing.
 *
 * Results arrive after the rows have painted. That is on purpose and the
 * rows must not reflow when they land — the chip is the last element in
 * the chip strip, and its slot is sized so appearing does not move the
 * path or the action.
 */
export function useCodeSignatures(
  desktopApi: DesktopApi | undefined,
  paths: Array<string | undefined>,
): Map<string, DesktopCodeSignature> {
  const [signatures, setSignatures] = useState<
    Map<string, DesktopCodeSignature>
  >(() => new Map());

  // Join into a stable dependency so a re-render with the same paths in
  // the same order does not re-run the probe. The paths are filesystem
  // paths, so `\n` cannot appear inside one and collide.
  const key = paths.filter((path): path is string => Boolean(path)).join("\n");

  useEffect(() => {
    const inspect = desktopApi?.inspectCodeSignatures;
    const requested = key ? key.split("\n") : [];
    if (!inspect || requested.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const result = await inspect({ paths: requested });
        if (cancelled) return;
        setSignatures((previous) => {
          const next = new Map(previous);
          for (const signature of result.signatures) {
            next.set(signature.path, signature);
          }
          return next;
        });
      } catch {
        // A signature chip is supplementary. A failed probe leaves the
        // rows exactly as they render before the answer arrives.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [desktopApi, key]);

  return signatures;
}
