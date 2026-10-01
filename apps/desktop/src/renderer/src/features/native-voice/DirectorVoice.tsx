import { useEffect, useRef, useState } from "react";
import {
  isRemoteFederationTarget,
  type AgentEvent,
  type NavigationLaunchpadDraft,
  type NavigationThreadSummary,
  type OperatorFocusSnapshot,
  type OperatorFocusView,
} from "@pwragent/shared";
import type { NativeVoiceApi } from "../../../../shared/native-voice";
import { CloseIcon, CopyIcon, MicIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatPrimaryAccel, isPlatformPrimaryAccel } from "../../lib/keyboard-accel";
import { useFloatingPanelRect, type FloatingPanelLimits } from "../../lib/useFloatingPanelRect";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { PendingQuestionnaire } from "../thread-detail/PendingQuestionnaire";
import {
  buildQuestionnaireResponse,
  createQuestionnaireState,
  type PendingQuestionnaireState,
} from "../thread-detail/questionnaire";
import { getWindowNativeVoiceController, type NativeVoiceController } from "./native-voice-controller";
import {
  isVoiceActive,
  useNativeVoice,
  VoiceElapsed,
  VoiceFeed,
  VoiceMicToggle,
  VoiceStatus,
  VoiceTextInput,
} from "./NativeVoice";

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

/**
 * The composer's mic where thread voice cannot open: a new-thread launchpad,
 * a peer's thread, or another provider's. It starts director voice, which
 * reads the same focus the window publishes, so it knows which project or
 * thread the operator means.
 */
export function DirectorVoiceComposerToggle({ api, hint }: { api: NativeVoiceApi; hint: string }) {
  const { controller, view } = useNativeVoice(api);
  const live = view.mode === "director" && isVoiceActive(view);
  const elsewhere = isVoiceActive(view) && !live;
  const blocked = elsewhere || view.status === "stopping";
  return (
    <button
      type="button"
      className={`composer__toggle tooltip-target${live ? " is-active" : ""}`}
      aria-label="Voice"
      aria-pressed={live}
      aria-disabled={blocked ? true : undefined}
      data-tooltip={elsewhere
        ? "Voice is on in a thread. End it to start director voice."
        : live ? "End director voice" : hint}
      onClick={() => {
        if (!blocked) void toggleDirectorVoice(api, controller);
      }}
    >
      <MicIcon size={15} aria-hidden="true" />
    </button>
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
export type DirectorFocusLaunchpad = Pick<
  NavigationLaunchpadDraft,
  "directoryKey" | "directoryLabel" | "federationTarget" | "backend" | "model" | "reasoningEffort" | "executionMode" | "workMode"
>;

/**
 * What the operator is looking at. A launchpad is reported only with no
 * thread selected, and never its draft text: settings only.
 */
export function operatorFocusFor(params: {
  view: OperatorFocusView;
  lens?: string;
  thread?: DirectorFocusThread;
  launchpad?: DirectorFocusLaunchpad;
}): OperatorFocusSnapshot {
  const thread = params.thread;
  const target = thread?.federation?.ref.target;
  const instanceId = target && isRemoteFederationTarget(target) ? target.instanceId : undefined;
  const launchpad = thread ? undefined : params.launchpad;
  const launchpadTarget = launchpad?.federationTarget;
  return {
    view: params.view,
    ...(params.lens ? { lens: params.lens } : {}),
    ...(launchpad
      ? {
          launchpad: {
            projectKey: launchpad.directoryKey,
            projectLabel: launchpad.directoryLabel.slice(0, 500),
            ...(launchpadTarget && isRemoteFederationTarget(launchpadTarget)
              ? { instanceId: launchpadTarget.instanceId }
              : {}),
            backend: launchpad.backend,
            ...(launchpad.model ? { model: launchpad.model } : {}),
            ...(launchpad.reasoningEffort ? { reasoningEffort: launchpad.reasoningEffort } : {}),
            ...(launchpad.executionMode ? { executionMode: launchpad.executionMode } : {}),
            ...(launchpad.workMode ? { workMode: launchpad.workMode } : {}),
          },
        }
      : {}),
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
/**
 * A question the Voice manager's turn is waiting on. Nobody reads that thread,
 * so a tool that asks the operator something there (a directory to trust, an
 * approval) would otherwise wait until the session ends. A questionnaire is
 * answered in place; anything else offers the thread itself.
 */
export type VoiceManagerRequest =
  | { kind: "questions"; state: PendingQuestionnaireState }
  | { kind: "other"; requestId: string; method: string };

const OTHER_REQUEST_METHODS = new Set([
  "turn/requestApproval",
  "review/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "mcpServer/elicitation/request",
]);

export function voiceManagerRequestFrom(
  event: AgentEvent,
  threadId: string,
): VoiceManagerRequest | "resolved" | undefined {
  const notification = event.notification as { method: string; params: Record<string, unknown> };
  if (event.backend !== "codex" || notification.params.threadId !== threadId) return undefined;
  const requestId = notification.params.requestId;
  if (typeof requestId !== "string") return undefined;
  if (notification.method === "serverRequest/resolved") return "resolved";
  if (notification.method === "item/tool/requestUserInput" && Array.isArray(notification.params.questions)) {
    const state = createQuestionnaireState(event.notification as Parameters<typeof createQuestionnaireState>[0]);
    return state ? { kind: "questions", state } : undefined;
  }
  return OTHER_REQUEST_METHODS.has(notification.method)
    ? { kind: "other", requestId, method: notification.method }
    : undefined;
}

function requestIdOf(request: VoiceManagerRequest): string {
  return request.kind === "questions" ? request.state.requestId : request.requestId;
}

function useVoiceManagerRequest(
  desktopApi: Pick<DesktopApi, "onAgentEvent"> | undefined,
  threadId: string | undefined,
) {
  const [request, setRequest] = useState<VoiceManagerRequest>();
  useEffect(() => {
    setRequest(undefined);
    if (!threadId || !desktopApi?.onAgentEvent) return;
    return desktopApi.onAgentEvent((event) => {
      const next = voiceManagerRequestFrom(event, threadId);
      if (next === "resolved") {
        const resolvedId = (event.notification.params as { requestId: string }).requestId;
        setRequest((current) => current && requestIdOf(current) === resolvedId ? undefined : current);
      } else if (next) {
        setRequest(next);
      }
    });
  }, [desktopApi, threadId]);
  return [request, setRequest] as const;
}

function VoiceManagerRequestCard({ desktopApi, onOpenThread, request, setRequest, threadId }: {
  desktopApi?: Pick<DesktopApi, "submitServerRequest">;
  onOpenThread?: (threadId: string) => void;
  request: VoiceManagerRequest;
  setRequest: (request: VoiceManagerRequest | undefined) => void;
  threadId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (request.kind === "other") {
    return (
      <div className="director-voice-panel__request" role="group" aria-label="Director voice is waiting on you">
        <p className="director-voice-panel__request-title">Waiting on you</p>
        <p className="director-voice-panel__request-text">The Voice manager needs an approval it cannot show here.</p>
        {onOpenThread ? (
          <button className="button button--primary" type="button" onClick={() => onOpenThread(threadId)}>
            Open Voice manager
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="director-voice-panel__request" role="group" aria-label="Director voice is waiting on you">
      <PendingQuestionnaire
        busy={busy}
        state={request.state}
        onChange={(state) => setRequest({ kind: "questions", state })}
        onSubmit={async (state) => {
          if (!desktopApi?.submitServerRequest) {
            setError("This window cannot answer the Voice manager.");
            return;
          }
          setBusy(true);
          setError(undefined);
          try {
            await desktopApi.submitServerRequest({
              backend: "codex",
              threadId,
              turnId: state.turnId,
              requestId: state.requestId,
              response: buildQuestionnaireResponse(state),
            });
            setRequest(undefined);
          } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : String(submitError));
          } finally {
            setBusy(false);
          }
        }}
      />
      {error ? <p className="director-voice-panel__request-error" role="alert">{error}</p> : null}
    </div>
  );
}

const PANEL_LIMITS: FloatingPanelLimits = { minWidth: 300, minHeight: 240, topReserve: 44 };
const PANEL_EDGE = 16;

/**
 * Director voice while it runs: a panel the operator can drag by its header
 * and resize from its corner, remembered between sessions. It is a working
 * surface, not a notice. It holds the conversation, the tool receipts, the
 * typed input, and any question the Voice manager is waiting on. Closing
 * ends voice. An error leaves the panel and arrives as an ordinary notice
 * (`useNativeVoiceNotices`).
 */
export function DirectorVoicePanel({ api, desktopApi, focus, launchpad, onOpenThread }: {
  api: NativeVoiceApi;
  desktopApi?: Pick<DesktopApi, "copyText" | "onAgentEvent" | "submitServerRequest">;
  focus?: DirectorFocusThread;
  launchpad?: Pick<NavigationLaunchpadDraft, "directoryLabel">;
  onOpenThread?: (threadId: string) => void;
}) {
  const { controller, view } = useNativeVoice(api);
  const open = view.mode === "director" && view.status !== "idle" && view.status !== "error";
  const [request, setRequest] = useVoiceManagerRequest(desktopApi, open ? view.threadId : undefined);
  const { rect, moveHandleProps, resizeHandleProps } = useFloatingPanelRect({
    storageKey: "pwragent:director-voice-panel",
    limits: PANEL_LIMITS,
    initial: (viewport) => {
      const width = 400;
      const height = Math.min(520, viewport.height - PANEL_LIMITS.topReserve - PANEL_EDGE * 2);
      return { x: PANEL_EDGE, y: viewport.height - height - PANEL_EDGE, width, height };
    },
  });
  if (!open) return null;
  const listening = view.status === "listening";
  const looking = focus
    ? `Looking at ${focus.title || "Untitled thread"}${focus.federation?.instanceLabel ? ` on ${focus.federation.instanceLabel}` : ""}.`
    : launchpad ? `Starting a new thread in ${launchpad.directoryLabel}.` : "No thread selected.";
  const transcript = [...view.transcript]
    .map((row) => `${row.role === "user" ? "You" : "Voice"}: ${row.text}`)
    .join("\n");
  return (
    <section
      className="director-voice-panel"
      aria-label="Director voice"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <header className="director-voice-panel__head" {...moveHandleProps}>
        <p className="director-voice-panel__title">Director voice</p>
        <VoiceStatus controller={controller} view={view} />
        <VoiceElapsed since={view.liveSince} />
        <div className="director-voice-panel__actions">
          <VoiceMicToggle controller={controller} view={view} />
          <button
            className="app-notice-toast__icon-button"
            type="button"
            aria-label="Copy transcript"
            title="Copy transcript"
            onClick={() => {
              void copyText(["Director voice", looking, transcript].filter(Boolean).join("\n"), desktopApi);
            }}
          >
            <CopyIcon size={13} aria-hidden="true" />
          </button>
          <button
            className="app-notice-toast__icon-button"
            type="button"
            aria-label="End director voice"
            title="End director voice"
            onClick={() => {
              if (view.status !== "stopping") void controller.stop();
            }}
          >
            <CloseIcon size={13} aria-hidden="true" />
          </button>
        </div>
      </header>
      <p className="director-voice-panel__focus">{looking}</p>
      {request && view.threadId ? (
        <VoiceManagerRequestCard
          desktopApi={desktopApi}
          onOpenThread={onOpenThread}
          request={request}
          setRequest={setRequest}
          threadId={view.threadId}
        />
      ) : null}
      <div className="director-voice-panel__feed">
        <VoiceFeed view={view} />
      </div>
      {listening ? <VoiceTextInput controller={controller} /> : null}
      <button
        className="director-voice-panel__grip"
        type="button"
        aria-label="Resize director voice"
        title="Drag or use the arrow keys to resize"
        {...resizeHandleProps}
      />
    </section>
  );
}
