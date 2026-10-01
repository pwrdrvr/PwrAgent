import { useEffect, useRef, useState } from "react";
import {
  isRemoteFederationTarget,
  type NavigationThreadSummary,
  type OperatorFocusSnapshot,
  type OperatorFocusView,
} from "@pwragent/shared";
import type { NativeVoiceApi } from "../../../../shared/native-voice";
import { MicIcon } from "../../icons";
import { formatPrimaryAccel, isPlatformPrimaryAccel } from "../../lib/keyboard-accel";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { getWindowNativeVoiceController, type NativeVoiceController } from "./native-voice-controller";
import { isVoiceActive, useNativeVoice, VoiceFeed, VoiceStatus, VoiceTextInput } from "./NativeVoice";

export function directorVoiceShortcutLabel(): string {
  return formatPrimaryAccel("Space", { shift: true });
}

/** ⌘⇧Space on macOS, Ctrl+Shift+Space elsewhere. Live inside text fields: no editing binding uses it. */
export function isDirectorVoiceShortcut(event: KeyboardEvent): boolean {
  return event.code === "Space" && event.shiftKey && !event.altKey && isPlatformPrimaryAccel(event);
}

let pendingOpen: Promise<void> | undefined;

/**
 * Start director voice on the Voice manager thread, or end it. Ending thread
 * voice is left to its own controls: the shortcut must not silently end a
 * conversation the operator started somewhere else.
 */
export function toggleDirectorVoice(api: NativeVoiceApi, controller: NativeVoiceController): Promise<void> {
  const view = controller.getView();
  if (isVoiceActive(view)) {
    return view.mode === "director" && view.status !== "stopping" ? controller.stop() : Promise.resolve();
  }
  if (pendingOpen) return pendingOpen;
  pendingOpen = (async () => {
    try {
      const opened = await api.openVoiceManager?.();
      if (!opened || opened.status === "failed") {
        controller.reportError(opened?.error ?? "Director voice is not available in this window.", "director");
        return;
      }
      await controller.start(opened.threadId, "director");
    } finally {
      pendingOpen = undefined;
    }
  })();
  return pendingOpen;
}

/** The masthead mic: the always-visible "voice is on" indicator, in every lens. */
/**
 * The mic's hover card: what director voice reaches and a few things to say,
 * because a bare mic gives no hint that it can run the whole fleet.
 */
function DirectorVoiceCard({ live }: { live: boolean }) {
  return (
    <>
      <span className="director-voice-card__header">
        <span className="director-voice-card__title">{live ? "End director voice" : "Director voice"}</span>
        <kbd className="director-voice-card__shortcut">{directorVoiceShortcutLabel()}</kbd>
      </span>
      <span className="director-voice-card__lede">
        Talk to every thread, on this machine and each connected one.
      </span>
      <span className="director-voice-card__section">Try saying</span>
      <ul className="director-voice-card__examples">
        <li>“Summarize the threads that need my attention.”</li>
        <li>“Start a thread on my Mac mini in the docs project to fix the broken links.”</li>
        <li>“Tell this thread to rerun the failing tests.”</li>
        <li>“What is the release thread on the studio machine doing?”</li>
      </ul>
    </>
  );
}

export function DirectorVoiceButton({ api }: { api: NativeVoiceApi }) {
  const { controller, view } = useNativeVoice(api);
  const tooltip = useViewportTooltip({ className: "director-voice-card" });
  const live = view.mode === "director" && isVoiceActive(view);
  const elsewhere = isVoiceActive(view) && !live;
  const content = elsewhere
    ? <span className="director-voice-card__lede">Voice is on in a thread. End it to start director voice.</span>
    : <DirectorVoiceCard live={live} />;
  return (
    <>
      <button
        aria-label="Director voice"
        aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
        aria-pressed={live}
        aria-disabled={elsewhere ? true : undefined}
        className={`sidebar__icon-button${live ? " is-active" : ""}`}
        type="button"
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          if (!elsewhere) void toggleDirectorVoice(api, controller);
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, content)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, content)}
        onMouseLeave={tooltip.hide}
      >
        <MicIcon size={16} aria-hidden="true" />
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

/** Registers the director shortcut for this window. */
export function useDirectorVoiceShortcut(api: NativeVoiceApi | undefined): void {
  useEffect(() => {
    if (!api?.openVoiceManager) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isDirectorVoiceShortcut(event)) return;
      event.preventDefault();
      void toggleDirectorVoice(api, getWindowNativeVoiceController(api));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api]);
}

export type DirectorFocusThread = Pick<NavigationThreadSummary, "id" | "source" | "title" | "federation">;

export function operatorFocusFor(params: {
  view: OperatorFocusView;
  lens?: string;
  thread?: DirectorFocusThread;
}): OperatorFocusSnapshot {
  const thread = params.thread;
  const target = thread?.federation?.ref.target;
  const instanceId = target && isRemoteFederationTarget(target) ? target.instanceId : undefined;
  return {
    view: params.view,
    ...(params.lens ? { lens: params.lens } : {}),
    ...(thread
      ? {
          thread: {
            backend: thread.source,
            threadId: thread.id,
            title: thread.title.slice(0, 500),
            ...(instanceId ? { instanceId } : {}),
            ...(thread.federation?.instanceLabel ? { instanceLabel: thread.federation.instanceLabel } : {}),
          },
        }
      : {}),
  };
}

/**
 * Tell main what the operator is looking at, for `read_operator_focus`.
 * Republishes on window focus so the answer follows the window in use.
 */
export function useOperatorFocusPublisher(api: NativeVoiceApi | undefined, focus: OperatorFocusSnapshot): void {
  const key = JSON.stringify(focus);
  const latest = useRef(focus);
  latest.current = focus;
  useEffect(() => {
    const publish = api?.publishOperatorFocus;
    if (!publish) return;
    const timer = window.setTimeout(() => { void publish(latest.current).catch(() => undefined); }, 150);
    return () => window.clearTimeout(timer);
  }, [api, key]);
  useEffect(() => {
    const publish = api?.publishOperatorFocus;
    if (!publish) return;
    const onFocus = () => { void publish(latest.current).catch(() => undefined); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [api]);
}

/**
 * Director voice, floating over the window while it runs. Stays put across
 * navigation; the context line names the thread "this" refers to.
 */
export function DirectorVoiceHud({ api, focus }: { api: NativeVoiceApi; focus?: DirectorFocusThread }) {
  const { controller, view } = useNativeVoice(api);
  const [collapsed, setCollapsed] = useState(false);
  if (view.mode !== "director" || view.status === "idle") return null;
  const listening = view.status === "listening";
  return (
    <section className="director-voice" aria-label="Director voice">
      <div className="director-voice__top">
        <VoiceStatus controller={controller} view={view} />
        <span className="director-voice__spacer" />
        {listening ? (
          <button className="button button--ghost" type="button" aria-pressed={view.muted} onClick={() => controller.setMuted(!view.muted)}>
            {view.muted ? "Unmute" : "Mute"}
          </button>
        ) : null}
        <button className="button button--ghost" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? "Show" : "Hide"}
        </button>
        {view.status === "error" ? (
          <button className="button button--ghost" type="button" onClick={() => controller.dismissError()}>Dismiss</button>
        ) : (
          <button className="button button--ghost native-voice__end" type="button" disabled={view.status === "stopping"} onClick={() => void controller.stop()}>
            End voice
          </button>
        )}
      </div>
      {view.error ? <p className="native-voice__error director-voice__error" role="alert">{view.error}</p> : null}
      {collapsed ? null : (
        <>
          <p className="director-voice__context">
            {focus ? (
              <>Looking at <span className="director-voice__chip">{focus.title || "Untitled thread"}</span>
                {focus.federation?.instanceLabel ? <> on <span className="director-voice__chip director-voice__chip--machine">{focus.federation.instanceLabel}</span></> : null}
              </>
            ) : "No thread selected"}
          </p>
          <VoiceFeed view={view} limit={12} />
          {listening ? <VoiceTextInput controller={controller} /> : null}
        </>
      )}
    </section>
  );
}
