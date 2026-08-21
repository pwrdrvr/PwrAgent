import { useEffect } from "react";
import { getDesktopApi, useDesktopApi } from "../../lib/desktop-api";
import { useThreadNavigation } from "../../lib/useThreadNavigation";
import { useThreadSessionState } from "../../lib/useThreadSessionState";
import { useThreadDraftIndicators } from "../../lib/useThreadDraftIndicators";
import { useComposerDraftStore } from "../composer/useComposerDraftStore";
import { useDurableComposerDraftStore } from "../composer/useDurableComposerDraftStore";
import { useDesktopSettings } from "../settings/useDesktopSettings";
import { StarMapScreen } from "./StarMapScreen";

/**
 * Root component for the dedicated Federation Star Map BrowserWindow.
 *
 * Mounted by `main.tsx` when `window.location.hash === "#star-map"`. The
 * spawn entry point is `showStarMapWindow()` in the main process.
 * Window-close goes through the OS traffic-light buttons; the map carries
 * no in-chrome Close button.
 *
 * The map used to live as a full-window layer inside the main shell and
 * received its data as props from `App`. As a standalone window it sources
 * the same inputs itself: the local navigation snapshot (live-patched over
 * `agent:event`, which the main process subscribes this window to),
 * event-derived session keys, and this window's own composer-draft
 * indicators. Cross-window navigation ("Open in full view", the local
 * instance card) goes back through main-process IPC that focuses the main
 * window.
 */
export function StarMapWindow() {
  const desktopApi = useDesktopApi();
  const settings = useDesktopSettings(desktopApi);
  const navigation = useThreadNavigation(desktopApi, { enabled: true });
  // No selected thread in this window — the hook only contributes its
  // event-derived approval/input/thinking key maps to the map's cards.
  const session = useThreadSessionState({ desktopApi });
  const baseComposerDraftStore = useComposerDraftStore();
  const composerDraftStore = useDurableComposerDraftStore(
    baseComposerDraftStore,
    desktopApi,
  );
  const draftThreadKeys = useThreadDraftIndicators({
    composerDraftStore,
    threads: navigation.threads,
  });

  // The renderer-side document title is what macOS shows in the Window
  // menu (the BrowserWindow's `title` option gets overridden by `<title>`
  // in `index.html`, which is shared with the main window).
  useEffect(() => {
    document.title = "Federation Star Map";
  }, []);

  // Windows draws its caption buttons in a frameless overlay, so the
  // window needs a painted drag strip the way every other aux window
  // does. macOS keeps the map full-bleed: the map's own top chrome
  // already reserves the stoplight gutter, but `hiddenInset` leaves no
  // native title-bar band to grab, so a transparent glass strip over the
  // top of the sky is the window's only drag handle. Linux keeps its
  // normal OS frame.
  const platform = getDesktopApi()?.platform;
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";

  return (
    <div className="star-map-window">
      {isMac ? (
        // Purely a window-drag handle: `-webkit-app-region: drag` means
        // macOS takes the mouse-down before the DOM sees it, so nothing
        // here can (or should) start a canvas pan. The slots of the map's
        // own top band carve `no-drag` holes so their controls stay
        // clickable inside the strip; the band between them does not, or
        // this window would have no drag handle left. Decorative to
        // assistive tech.
        <div aria-hidden="true" className="star-map-window__titlebar" />
      ) : null}
      {isWindows ? (
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          <div className="activity-titlebar__breadcrumb">
            <span className="activity-titlebar__eyebrow">Federation</span>
            <span aria-hidden="true" className="activity-titlebar__separator">
              ›
            </span>
            <span className="activity-titlebar__current">Star Map</span>
          </div>
          <div className="activity-titlebar__spacer" />
        </header>
      ) : null}
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={navigation.threads}
        draftThreadKeys={draftThreadKeys}
        sessionKeys={{
          approvalRequestThreadKeys: session.approvalRequestThreadKeys,
          inputRequestThreadKeys: session.inputRequestThreadKeys,
          thinkingThreadKeys: session.thinkingThreadKeys,
        }}
        localInstanceLabel={settings.snapshot?.federation.instanceLabel.value}
        pastedImageMaxPatches={
          settings.snapshot?.imageUploads.pastedImageMaxPatches.value
        }
        pricingDisplayOptions={{
          codexCredits:
            settings.snapshot?.experimental.threadPricingDisplayCodexCredits
              ?.value ?? false,
          usd:
            settings.snapshot?.experimental.threadPricingDisplayUsd?.value
            ?? true,
        }}
        threadPricingSummaryEnabled={
          settings.snapshot?.experimental.threadPricingSummary?.value ?? true
        }
        onOpenLocalThread={(thread) => {
          void desktopApi?.openStarMapThreadInMainWindow?.({
            backend: thread.source,
            threadId: thread.id,
          });
        }}
        onFocusLocalInstance={() => {
          void desktopApi?.focusMainWindowFromStarMap?.();
        }}
        onRefreshLocalThreads={navigation.refresh}
      />
    </div>
  );
}
