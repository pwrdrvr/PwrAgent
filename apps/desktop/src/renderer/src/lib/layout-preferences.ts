/**
 * Layout preferences as of first render, from the main-process bootstrap.
 *
 * `App.tsx` used to default the rail to pinned-open and the sidebar to
 * shown, then adopt the stored values when the settings snapshot arrived
 * over IPC. That is a paint of one layout followed by a correction to
 * another: a pinned rail reserves `--context-rail-effective` plus its gutter
 * (428px), so an operator whose rail is unpinned could watch the transcript
 * paint narrow and jump wider, and anything measuring across the moment
 * measured two different layouts. Whether it happens at all is a race
 * against the snapshot; see `main/layout-prefs-bootstrap.ts` for what was
 * and was not measured.
 *
 * `window.__pwragentLayoutPreferences` is set by the preload before any
 * renderer script runs, the same channel the thread lens and the appearance
 * tokens already use. Falling back here is not a silent default: an
 * auxiliary window without the hint gets exactly the values `App.tsx`
 * hard-coded before, so nothing regresses if the argument is missing.
 */
import { DESKTOP_UI_LAYOUT_DEFAULTS } from "@pwragent/shared";

export type RendererLayoutPreferences = {
  contextRailPinned: boolean;
  sidebarHidden: boolean;
};

export const RENDERER_LAYOUT_FALLBACK: RendererLayoutPreferences =
  DESKTOP_UI_LAYOUT_DEFAULTS;

export function readBootstrapLayoutPreferences(): RendererLayoutPreferences {
  const bridged = (globalThis as typeof globalThis & {
    __pwragentLayoutPreferences?: Partial<RendererLayoutPreferences>;
  }).__pwragentLayoutPreferences;
  return {
    contextRailPinned: typeof bridged?.contextRailPinned === "boolean"
      ? bridged.contextRailPinned
      : RENDERER_LAYOUT_FALLBACK.contextRailPinned,
    sidebarHidden: typeof bridged?.sidebarHidden === "boolean"
      ? bridged.sidebarHidden
      : RENDERER_LAYOUT_FALLBACK.sidebarHidden,
  };
}
