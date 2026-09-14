/**
 * Synchronous layout-preference read for the main BrowserWindow.
 *
 * The context rail and the sidebar must be correct before React's first
 * visible render, for the same reason the thread lens must be
 * (`navigation-browse-mode-bootstrap.ts`): the renderer otherwise paints a
 * default, then corrects it when the settings snapshot arrives over IPC.
 *
 * `App.tsx` defaulted `contextRailPinned` to `true` and adopted the stored
 * value in an effect keyed on that snapshot, so the window paints one layout
 * and then corrects it. A pinned rail reserves `--context-rail-effective`
 * plus its gutter — 428px — so the correction reflows the transcript, and
 * anything measuring across the moment measures two different layouts.
 *
 * Which side wins is a race, and it is not decided here. Under the E2E
 * launch path on this host the snapshot lands first, so the rail mounts
 * already collapsed and the reflow is invisible; a dev launch that had the
 * rail on screen earlier showed the other order:
 *
 *     +70ms  class=context-rail is-open is-pinned
 *     +111ms class=context-rail is-collapsed
 *
 * `markdown-findings-table.spec.ts` is what made it visible. It failed that
 * lane twice with `assistantWidth=566` against `proseWidth=760`, and those
 * two numbers cannot describe one layout: `.transcript-message` is
 * `width: min(100%, 760px)` capped at `max-width: 84%` while
 * `.transcript-message--table-wide` is `width: 100%`, so a wide message is
 * the container and a prose message is at most 84% of it. 760px of prose
 * needs a container of at least 905px; the table measured 566. The
 * transcript grew by ~340px between the spec's two reads, and the rail is
 * the only thing in the thread view that size. The spec asks for
 * `contextRailPinned: false`, which used to arrive with the settings
 * snapshot; it now measures both widths in one evaluate as well, so it can
 * no longer straddle a reflow of any origin.
 *
 * Reads the config store when this process has one and the profile's
 * `config.toml` otherwise, which is exactly how `readBootstrapAppearance`
 * resolves theme and density. `[ui]` lives in that file, not in the overlay
 * store the browse-mode bootstrap reads.
 */

import { resolveDesktopConfigPath } from "./settings/desktop-config";
import { readProfileConfigFile } from "./settings/config-store/profile-config-file";
import { getExistingDesktopConfigStore } from "./settings/config-store/desktop-config-store-singleton";

export type BootstrapLayoutPreferences = {
  contextRailPinned: boolean;
  sidebarHidden: boolean;
};

/** Matches `App.tsx`'s own initial state before this bootstrap existed. */
export const BOOTSTRAP_LAYOUT_DEFAULTS: BootstrapLayoutPreferences = {
  contextRailPinned: true,
  sidebarHidden: false,
};

export const BOOTSTRAP_LAYOUT_ARG_PREFIX = "--pwragent-layout-preferences=";

export function readBootstrapLayoutPreferences(
  configPath?: string,
): BootstrapLayoutPreferences {
  if (!configPath) {
    // The running process already has the file parsed, and a window opened
    // after the operator toggled the rail must reflect that, not the value
    // on disk at the moment the store last wrote it.
    const stored = getExistingDesktopConfigStore()?.read("ui");
    if (stored) {
      return {
        contextRailPinned:
          stored.contextRailPinned
          ?? BOOTSTRAP_LAYOUT_DEFAULTS.contextRailPinned,
        sidebarHidden:
          stored.sidebarHidden ?? BOOTSTRAP_LAYOUT_DEFAULTS.sidebarHidden,
      };
    }
  }
  try {
    const config = readProfileConfigFile(
      configPath ?? resolveDesktopConfigPath(),
    );
    return {
      contextRailPinned:
        config.ui?.contextRailPinned
        ?? BOOTSTRAP_LAYOUT_DEFAULTS.contextRailPinned,
      sidebarHidden:
        config.ui?.sidebarHidden ?? BOOTSTRAP_LAYOUT_DEFAULTS.sidebarHidden,
    };
  } catch {
    // Config missing / unreadable / malformed. The renderer's full settings
    // load surfaces the error through its normal path; this synchronous read
    // is best-effort, exactly as the appearance bootstrap's is.
    return { ...BOOTSTRAP_LAYOUT_DEFAULTS };
  }
}

export function layoutPreferencesAdditionalArguments(
  preferences: BootstrapLayoutPreferences,
): string[] {
  return [serializeBootstrapLayoutPreferences(preferences)];
}

export function serializeBootstrapLayoutPreferences(
  preferences: BootstrapLayoutPreferences,
): string {
  return `${BOOTSTRAP_LAYOUT_ARG_PREFIX}${JSON.stringify(preferences)}`;
}

export function parseBootstrapLayoutPreferencesArg(
  argv: readonly string[],
): BootstrapLayoutPreferences | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(BOOTSTRAP_LAYOUT_ARG_PREFIX)) continue;
    try {
      const raw: unknown = JSON.parse(
        arg.slice(BOOTSTRAP_LAYOUT_ARG_PREFIX.length),
      );
      const parsed = raw as Partial<BootstrapLayoutPreferences> | null;
      return {
        contextRailPinned:
          typeof parsed?.contextRailPinned === "boolean"
            ? parsed.contextRailPinned
            : BOOTSTRAP_LAYOUT_DEFAULTS.contextRailPinned,
        sidebarHidden:
          typeof parsed?.sidebarHidden === "boolean"
            ? parsed.sidebarHidden
            : BOOTSTRAP_LAYOUT_DEFAULTS.sidebarHidden,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
