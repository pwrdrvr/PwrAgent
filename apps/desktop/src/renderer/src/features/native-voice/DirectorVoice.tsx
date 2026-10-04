import { cameraCueLabel, VoiceCameraButton, VoiceCameraDock } from "./VoiceCameraButton";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { tooltipHandlers, useViewportTooltip } from "../../lib/useViewportTooltip";
import { PendingQuestionnaire } from "../thread-detail/PendingQuestionnaire";
import {
  buildQuestionnaireResponse,
  createQuestionnaireState,
  type PendingQuestionnaireState,
} from "../thread-detail/questionnaire";
import {
  getWindowNativeVoiceController,
  MUTED_IDLE_END_MS,
  type NativeVoiceController,
  type VoiceView,
} from "./native-voice-controller";
import {
  CUE_DELIVERY_LABEL,
  isVoiceActive,
  useNativeVoice,
  VoiceElapsed,
  VoiceFeed,
  VoiceLevelMeter,
  VoiceMicToggle,
  voiceStateLabel,
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

/**
 * The Voice manager's pending question: whatever main still holds when the
 * panel opens (a question can outlive the voice session that raised it), then
 * live requests and resolutions. A live event always wins over the read.
 */
function useVoiceManagerRequest(
  desktopApi: Pick<DesktopApi, "onAgentEvent" | "readThread"> | undefined,
  threadId: string,
) {
  const [request, setRequest] = useState<VoiceManagerRequest>();
  useEffect(() => {
    if (!desktopApi?.onAgentEvent) return;
    let live = false;
    const off = desktopApi.onAgentEvent((event) => {
      const next = voiceManagerRequestFrom(event, threadId);
      if (next === "resolved") {
        live = true;
        const resolvedId = (event.notification.params as { requestId: string }).requestId;
        setRequest((current) => current && requestIdOf(current) === resolvedId ? undefined : current);
      } else if (next) {
        live = true;
        setRequest(next);
      }
    });
    void desktopApi.readThread?.({ backend: "codex", threadId, includeTurns: false, limit: 1 })
      .then((response) => {
        if (live || !response.pendingRequest) return;
        const pending = voiceManagerRequestFrom(
          { backend: "codex", notification: response.pendingRequest } as AgentEvent,
          threadId,
        );
        if (pending && pending !== "resolved") setRequest(pending);
      })
      .catch(() => undefined);
    return off;
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

type DirectorVoicePanelProps = {
  api: NativeVoiceApi;
  desktopApi?: Pick<DesktopApi, "copyText" | "onAgentEvent" | "readThread" | "submitServerRequest">;
  focus?: DirectorFocusThread;
  launchpad?: Pick<NavigationLaunchpadDraft, "directoryLabel">;
  onOpenThread?: (threadId: string) => void;
};

/**
 * Director voice: a panel the operator can drag by its header and resize
 * from its corner, remembered between sessions. It is a working surface, not
 * a notice. It holds the conversation, the tool receipts, the typed input,
 * and any question the Voice manager is waiting on.
 *
 * The panel outlives the session. When voice ends on its own (muted after a
 * reply, or a failure, which also arrives as an ordinary notice through
 * `useNativeVoiceNotices`), the transcript stays with the clock stopped
 * until the operator closes it or starts again. Three controls, three
 * intents: mute stops the director hearing the room, End stops the session
 * and keeps the transcript, and Close ends a live session and closes it.
 *
 * Mounted for the window's life; its geometry, tooltips and request watch
 * exist only while the panel is open.
 */
export function DirectorVoicePanel(props: DirectorVoicePanelProps) {
  const { controller, view } = useNativeVoice(props.api);
  const [shown, setShown] = useState<ShownDirectorVoice>();
  const closing = useRef(false);
  useEffect(() => controller.subscribe((next) => {
    const live = next.mode === "director" && isVoiceActive(next) && next.threadId !== undefined;
    if (live) {
      setShown({ view: next });
      return;
    }
    const endedAt = Date.now();
    const closed = closing.current;
    closing.current = false;
    setShown((current) => {
      if (!current) return current;
      if (current.endedAt !== undefined) {
        // A cue receipt can settle after the session ended; the kept
        // transcript takes the settled state rather than "sending…".
        return next.mode === "director" && next.threadId === current.view.threadId
          && next.cameraCues !== undefined && next.cameraCues !== current.view.cameraCues
          ? { ...current, view: { ...current.view, cameraCues: next.cameraCues } }
          : current;
      }
      // The last live view keeps the transcript; a failure clears the
      // controller's own view before the operator has read it.
      return closed ? undefined : { view: current.view, endedAt };
    });
  }), [controller]);
  if (!shown?.view.threadId) return null;
  return (
    <OpenDirectorVoicePanel
      {...props}
      controller={controller}
      endedAt={shown.endedAt}
      // Another session (thread voice) is open: starting again would be refused.
      otherVoiceActive={isVoiceActive(view)}
      onClose={() => {
        if (shown.endedAt !== undefined) {
          setShown(undefined);
          return;
        }
        closing.current = true;
        if (view.status !== "stopping") void controller.stop();
      }}
      onEnd={() => {
        if (view.status !== "stopping") void controller.stop();
      }}
      threadId={shown.view.threadId}
      view={shown.endedAt === undefined ? shown.view : { ...shown.view, status: "idle", muted: false }}
    />
  );
}

type ShownDirectorVoice = { view: VoiceView; endedAt?: number };

const MUTED_IDLE_END_SECONDS = Math.round(MUTED_IDLE_END_MS / 1000);

/**
 * The panel's state, on its own row under the header. The labels differ
 * widely in width; on the header row the longest one squeezed the title
 * and, at narrow widths, pushed the controls off the panel. Here only the
 * muted consequence yields, by ellipsis.
 */
function DirectorVoiceState({ action, controller, ended, view }: {
  /** End while live, Start again once ended: it acts on the session this row describes. */
  action?: ReactNode;
  controller: NativeVoiceController;
  ended: boolean;
  view: VoiceView;
}) {
  const live = !ended && view.status === "listening" && !view.muted;
  const muted = !ended && view.status === "listening" && view.muted;
  const label = ended
    ? view.endedAfterAway ? "Ended while you were away" : view.endedAfterReply ? "Ended after the reply" : "Voice ended"
    : live ? "Microphone live" : muted ? "Muted" : voiceStateLabel(view);
  return (
    <p
      className={live ? "director-voice-panel__state director-voice-panel__state--live" : "director-voice-panel__state"}
      role="status"
      aria-label="Voice status"
    >
      <span className="director-voice-panel__state-dot" aria-hidden="true" />
      <span className="director-voice-panel__state-label">{label}</span>
      {live ? <VoiceLevelMeter controller={controller} /> : null}
      {muted ? (
        <>
          <span className="director-voice-panel__state-sep" aria-hidden="true">·</span>
          <span className="director-voice-panel__state-detail">ends {MUTED_IDLE_END_SECONDS}s after the reply</span>
        </>
      ) : null}
      {action}
    </p>
  );
}

/** The panel's tooltips portal to the body, so they carry the panel's layer. */
const PANEL_TOOLTIP_CLASS = "viewport-tooltip director-voice-panel__tooltip";

function OpenDirectorVoicePanel({
  api, controller, desktopApi, endedAt, focus, launchpad, onClose, onEnd, onOpenThread, otherVoiceActive, threadId, view,
}: DirectorVoicePanelProps & {
  controller: NativeVoiceController;
  endedAt?: number;
  onClose: () => void;
  /** Ends the session and keeps the panel, with its transcript. */
  onEnd: () => void;
  otherVoiceActive: boolean;
  threadId: string;
  view: VoiceView;
}) {
  const [request, setRequest] = useVoiceManagerRequest(desktopApi, threadId);
  const tooltip = useViewportTooltip({ className: PANEL_TOOLTIP_CLASS });
  const { rect, moveHandleProps, resizeHandleProps } = useFloatingPanelRect({
    storageKey: "pwragent:director-voice-panel",
    limits: PANEL_LIMITS,
    // Top right, below the title strip: the notice stack owns the bottom-left
    // corner and draws over this panel, and the composer owns the bottom.
    initial: (viewport) => {
      const width = 400;
      const height = Math.min(520, viewport.height - PANEL_LIMITS.topReserve - PANEL_EDGE);
      return { x: viewport.width - width - PANEL_EDGE, y: PANEL_LIMITS.topReserve, width, height };
    },
  });
  const ended = endedAt !== undefined;
  const listening = view.status === "listening";
  const endHadFocus = useRef(false);
  // What "this" means to the voice, so it describes the window, never an
  // action. It follows the window live, so it goes when the session ends.
  const looking = ended ? undefined : focus
    ? `Looking at: ${focus.title || "Untitled thread"}${focus.federation?.instanceLabel ? ` on ${focus.federation.instanceLabel}` : ""}`
    : launchpad ? `Looking at: new thread in ${launchpad.directoryLabel}` : "Looking at: no thread";
  const transcript = [
    ...view.transcript.map((row) => ({ seq: row.seq, line: `${row.role === "user" ? "You" : "Director"}: ${row.text}` })),
    ...(view.cameraCues ?? []).map((row) => ({ seq: row.seq, line: `[camera: ${cameraCueLabel(row.cue)}, ${CUE_DELIVERY_LABEL[row.delivery]}]` })),
  ]
    .sort((left, right) => left.seq - right.seq)
    .map((row) => row.line)
    .join("\n");
  return (
    <section
      className="director-voice-panel"
      aria-label="Director voice"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <header className="director-voice-panel__head" {...moveHandleProps}>
        <p className="director-voice-panel__title">Director voice</p>
        <VoiceElapsed since={view.liveSince} until={endedAt} />
        <div className="director-voice-panel__actions">
          {!ended ? <VoiceMicToggle controller={controller} tooltipClassName={PANEL_TOOLTIP_CLASS} view={view} /> : null}
          {!ended ? <VoiceCameraButton controller={controller} tooltipClassName={PANEL_TOOLTIP_CLASS} view={view} /> : null}
          <button
            className="app-notice-toast__icon-button"
            type="button"
            aria-label="Copy transcript"
            {...tooltipHandlers(tooltip, "Copy transcript")}
            onClick={() => {
              void copyText(["Director voice", looking, transcript].filter(Boolean).join("\n"), desktopApi);
            }}
          >
            <CopyIcon size={13} aria-hidden="true" />
          </button>
          <button
            className="app-notice-toast__icon-button"
            type="button"
            aria-label="Close director voice"
            {...tooltipHandlers(tooltip, ended ? "Close director voice" : "Close. Ends director voice.")}
            onClick={() => {
              tooltip.hide();
              onClose();
            }}
          >
            <CloseIcon size={13} aria-hidden="true" />
          </button>
        </div>
      </header>
      <DirectorVoiceState
        action={ended ? (
          otherVoiceActive ? null : (
            <button
              ref={(node) => {
                if (node && endHadFocus.current) {
                  endHadFocus.current = false;
                  node.focus();
                }
              }}
              className="button button--ghost director-voice-panel__session director-voice-panel__session--start"
              type="button"
              onClick={() => { void toggleDirectorVoice(api, controller); }}
            >
              <MicIcon size={13} aria-hidden="true" />
              Start again
            </button>
          )
        ) : (
          <button
            className="button button--ghost director-voice-panel__session"
            type="button"
            aria-label="End director voice"
            // Not `disabled`: that drops focus to <body> mid-stop. Start
            // again takes focus when it replaces this button.
            aria-disabled={view.status === "stopping" ? true : undefined}
            {...tooltipHandlers(tooltip, "End the session. The transcript stays.")}
            onClick={(event) => {
              tooltip.hide();
              if (view.status === "stopping") return;
              endHadFocus.current = event.currentTarget === document.activeElement;
              onEnd();
            }}
          >
            <span className="director-voice-panel__session-stop" aria-hidden="true" />
            End
          </button>
        )}
        controller={controller}
        ended={ended}
        view={view}
      />
      {looking ? <p className="director-voice-panel__focus">{looking}</p> : null}
      {request ? (
        <VoiceManagerRequestCard
          desktopApi={desktopApi}
          onOpenThread={onOpenThread}
          request={request}
          setRequest={setRequest}
          threadId={threadId}
        />
      ) : null}
      <div className="director-voice-panel__feed">
        <VoiceFeed view={view} scrollParent assistant="Director" />
      </div>
      {/* A sibling of the feed, never inside it: the camera holds one place
          while the transcript scrolls above it. */}
      <VoiceCameraDock
        controller={controller}
        onCopyDiagnostics={(text) => { void copyText(text, desktopApi); }}
        tooltipClassName={PANEL_TOOLTIP_CLASS}
        view={view}
      />
      {listening ? <VoiceTextInput controller={controller} recipient="director" sendLabel="Send" /> : null}
      <button
        className="director-voice-panel__grip"
        type="button"
        aria-label="Resize director voice"
        {...tooltipHandlers(tooltip, "Drag, or use the arrow keys, to resize")}
        {...resizeHandleProps}
      />
      {tooltip.tooltipNode}
    </section>
  );
}
