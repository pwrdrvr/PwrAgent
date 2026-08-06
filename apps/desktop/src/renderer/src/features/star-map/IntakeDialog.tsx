import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CelestialIconId,
  FederationTarget,
  StarMapIntakeCandidate,
  StarMapIntakePhase,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { CelestialIcon } from "../../icons";

export type IntakeDialogTarget = {
  instanceId: string;
  label: string;
  icon?: CelestialIconId;
  /** Remote target when the [+] belongs to another instance. */
  federationTarget?: FederationTarget;
};

const PHASE_COPY: Partial<Record<StarMapIntakePhase, string>> = {
  resolving: "Finding the right project…",
  creating: "Creating the thread…",
};

/**
 * The Star Map [+] intake chat: describe a task in natural language and the
 * owning instance resolves the project (its registry + AGENTS.md
 * preferences), creates the thread, and the new card bubbles into the map.
 */
export function IntakeDialog(props: {
  desktopApi?: DesktopApi;
  target: IntakeDialogTarget;
  onClose: () => void;
  onCreated: (created: {
    instanceId: string;
    backend: string;
    threadId: string;
  }) => void;
}) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<StarMapIntakePhase | "idle">("idle");
  const [error, setError] = useState<string>();
  const [candidates, setCandidates] = useState<StarMapIntakeCandidate[]>();
  const requestIdRef = useRef<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase === "resolving" || phase === "creating";

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Stream progress: the owning instance publishes starMap/intake/status
  // for our requestId (fanned over federation for remote targets).
  useEffect(() => {
    const unsubscribe = props.desktopApi?.onAgentEvent?.((event) => {
      if (event.notification.method !== "starMap/intake/status") return;
      const params = event.notification.params as {
        requestId: string;
        phase: StarMapIntakePhase;
        message?: string;
      };
      if (params.requestId !== requestIdRef.current) return;
      setPhase(params.phase);
      if (params.phase === "failed" && params.message) {
        setError(params.message);
      }
    });
    return () => unsubscribe?.();
  }, [props.desktopApi]);

  const submit = (directoryKey?: string) => {
    const request = text.trim();
    if (!request || busy || !props.desktopApi?.dispatchStarMapIntake) return;
    const requestId =
      requestIdRef.current ?? `intake-${Math.random().toString(36).slice(2)}`;
    requestIdRef.current = requestId;
    setError(undefined);
    setCandidates(undefined);
    setPhase("resolving");
    void props.desktopApi
      .dispatchStarMapIntake({
        requestId,
        request,
        directoryKey,
        federationTarget: props.target.federationTarget,
      })
      .then((response) => {
        if (response.requestId !== requestIdRef.current) return;
        if (response.status === "created") {
          setPhase("done");
          props.onCreated({
            instanceId: props.target.instanceId,
            backend: response.backend,
            threadId: response.threadId,
          });
          props.onClose();
          return;
        }
        if (response.status === "needs_disambiguation") {
          setPhase("needs_disambiguation");
          setCandidates(response.candidates);
          return;
        }
        setPhase("failed");
        setError(response.error);
      })
      .catch((err: unknown) => {
        setPhase("failed");
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return createPortal(
    <div
      className="star-map-intake"
      role="dialog"
      aria-modal="true"
      aria-label={`New thread on ${props.target.label}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <button
        type="button"
        className="star-map-intake__backdrop"
        aria-label="Close intake"
        tabIndex={-1}
        onClick={() => {
          if (!busy) props.onClose();
        }}
      />
      <div className="star-map-intake__panel">
        <div className="star-map-intake__header">
          {props.target.icon ? (
            <CelestialIcon icon={props.target.icon} size={20} />
          ) : null}
          <span className="star-map-intake__target">{props.target.label}</span>
          <button
            type="button"
            className="star-map-intake__close"
            aria-label="Close"
            disabled={busy}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="star-map-intake__input"
          placeholder="Give me a task, tell me the project, and any specifics that don't match your defaults."
          value={text}
          disabled={busy}
          rows={4}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter"
              && (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {candidates ? (
          <div className="star-map-intake__candidates">
            <p className="star-map-intake__hint">Which project?</p>
            {candidates.map((candidate) => (
              <button
                key={candidate.directoryKey}
                type="button"
                className="star-map-intake__candidate"
                onClick={() => submit(candidate.directoryKey)}
              >
                <span className="star-map-intake__candidate-label">
                  {candidate.label}
                </span>
                {candidate.path ? (
                  <span className="star-map-intake__candidate-path">
                    {candidate.path}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="star-map-intake__footer">
          <span
            className={`star-map-intake__status${
              busy ? " is-busy" : ""
            }${phase === "failed" ? " is-failed" : ""}`}
            role="status"
          >
            {phase === "failed" ? error : PHASE_COPY[phase as StarMapIntakePhase] ?? ""}
          </span>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy || text.trim().length === 0}
            onClick={() => submit()}
          >
            {busy ? "Working…" : "Start thread"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
