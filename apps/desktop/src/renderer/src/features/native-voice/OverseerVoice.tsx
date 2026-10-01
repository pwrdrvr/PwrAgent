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

export function overseerVoiceShortcutLabel(): string {
  return formatPrimaryAccel("Space", { shift: true });
}

/** ⌘⇧Space on macOS, Ctrl+Shift+Space elsewhere. Live inside text fields: no editing binding uses it. */
export function isOverseerVoiceShortcut(event: KeyboardEvent): boolean {
  return event.code === "Space" && event.shiftKey && !event.altKey && isPlatformPrimaryAccel(event);
}

let pendingOpen: Promise<void> | undefined;

/**
 * Start overseer voice on the Voice manager thread, or end it. Ending thread
 * voice is left to its own controls: the shortcut must not silently end a
 * conversation the operator started somewhere else.
 */
export function toggleOverseerVoice(api: NativeVoiceApi, controller: NativeVoiceController): Promise<void> {
  const view = controller.getView();
  if (isVoiceActive(view)) {
    return view.mode === "overseer" && view.status !== "stopping" ? controller.stop() : Promise.resolve();
  }
  if (pendingOpen) return pendingOpen;
  pendingOpen = (async () => {
    try {
      const opened = await api.openVoiceManager?.();
      if (!opened || opened.status === "failed") {
        controller.reportError(opened?.error ?? "Overseer voice is not available in this window.", "overseer");
        return;
      }
      await controller.start(opened.threadId, "overseer");
    } finally {
      pendingOpen = undefined;
    }
  })();
  return pendingOpen;
}

/** The masthead mic: the always-visible "voice is on" indicator, in every lens. */
export function OverseerVoiceButton({ api }: { api: NativeVoiceApi }) {
  const { controller, view } = useNativeVoice(api);
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const live = view.mode === "overseer" && isVoiceActive(view);
  const elsewhere = isVoiceActive(view) && !live;
  const label = elsewhere
    ? "Voice is on in a thread. End it to start overseer voice."
    : live ? `End overseer voice  (${overseerVoiceShortcutLabel()})` : `Overseer voice  (${overseerVoiceShortcutLabel()})`;
  return (
    <>
      <button
        aria-label="Overseer voice"
        aria-pressed={live}
        aria-disabled={elsewhere ? true : undefined}
        className={`sidebar__icon-button${live ? " is-active" : ""}`}
        type="button"
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          if (!elsewhere) void toggleOverseerVoice(api, controller);
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, label)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, label)}
        onMouseLeave={tooltip.hide}
      >
        <MicIcon size={16} aria-hidden="true" />
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

/** Registers the overseer shortcut for this window. */
export function useOverseerVoiceShortcut(api: NativeVoiceApi | undefined): void {
  useEffect(() => {
    if (!api?.openVoiceManager) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isOverseerVoiceShortcut(event)) return;
      event.preventDefault();
      void toggleOverseerVoice(api, getWindowNativeVoiceController(api));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api]);
}

export type OverseerFocusThread = Pick<NavigationThreadSummary, "id" | "source" | "title" | "federation">;

export function operatorFocusFor(params: {
  view: OperatorFocusView;
  lens?: string;
  thread?: OverseerFocusThread;
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
 * Overseer voice, floating over the window while it runs. Stays put across
 * navigation; the context line names the thread "this" refers to.
 */
export function OverseerVoiceHud({ api, focus }: { api: NativeVoiceApi; focus?: OverseerFocusThread }) {
  const { controller, view } = useNativeVoice(api);
  const [collapsed, setCollapsed] = useState(false);
  if (view.mode !== "overseer" || view.status === "idle") return null;
  const listening = view.status === "listening";
  return (
    <section className="overseer-voice" aria-label="Overseer voice">
      <div className="overseer-voice__top">
        <VoiceStatus controller={controller} view={view} />
        <span className="overseer-voice__spacer" />
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
      {view.error ? <p className="native-voice__error overseer-voice__error" role="alert">{view.error}</p> : null}
      {collapsed ? null : (
        <>
          <p className="overseer-voice__context">
            {focus ? (
              <>Looking at <span className="overseer-voice__chip">{focus.title || "Untitled thread"}</span>
                {focus.federation?.instanceLabel ? <> on <span className="overseer-voice__chip overseer-voice__chip--machine">{focus.federation.instanceLabel}</span></> : null}
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
