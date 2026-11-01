export const DIAGNOSTICS_CAPTURE_RENDERING_CHANNEL = "diagnostics:capture-rendering";
export const DIAGNOSTICS_STOP_RENDERING_CHANNEL = "diagnostics:stop-rendering";

export type RenderingCaptureResult = {
  summaryPath: string;
  durationMs: number;
};

/** Self-contained: main serializes this function into each renderer on demand. */
export function readRenderingSnapshot() {
  const names = new Set([
    "pwragent-thinking-scanner-sweep", "status-blink", "pending-spinner-spin",
    "app-update-banner-sweep", "settings-keyboard-example", "star-map-intake-pulse",
    "missing-worktree-card-scan", "usage-pace-ping",
  ]);
  const sources = [
    ".thinking-scanner", ".pending-spinner", ".status-dot", ".rail-chip", ".pr-chip", ".star-map-card",
  ];
  const animations = document.getAnimations();
  const groups = new Map<string, number>();
  for (const animation of animations.slice(0, 128)) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    const rect = target instanceof Element ? target.getBoundingClientRect() : null;
    const inViewport = Boolean(rect && rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
    // CSS animations are named by their keyframes; script animations by `id`.
    const name = animation instanceof CSSAnimation
      ? (names.has(animation.animationName) ? animation.animationName : "other")
      : (names.has(animation.id) ? animation.id : "other");
    const source = target instanceof Element
      ? sources.find((selector) => target.closest(selector)) ?? "other" : "other";
    const infinite = animation.effect?.getTiming().iterations === Infinity;
    const key = JSON.stringify([name, source, animation.playState, infinite, inViewport]);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const updates = (window as unknown as {
    __pwragentRendererUpdates?: { snapshot: () => { counts: number[] } };
  }).__pwragentRendererUpdates?.snapshot().counts ?? [];
  // Only fixed route labels. Hash suffixes can contain private thread IDs.
  const routes = ["settings", "star-map", "logs", "messaging-activity", "federation-activity", "usage-activity", "changelog", "license"];
  const view = routes.find((route) => location.hash === `#${route}`
    || location.hash.startsWith(`#${route}?`)) ?? "main-or-other";
  return {
    view,
    visibility: document.visibilityState,
    animations: [...groups].map(([key, count]) => ({
      // These strings come only from the fixed names/selectors above and browser enums.
      state: JSON.parse(key) as [string, string, string, boolean, boolean],
      count,
    })),
    omittedAnimations: Math.max(0, animations.length - 128),
    updateCounts: updates.slice(0, 64).map((value) => Number.isFinite(value) ? value : 0),
  };
}
