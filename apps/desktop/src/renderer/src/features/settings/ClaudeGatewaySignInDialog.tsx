import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  isClaudeGatewaySignInFinished,
  type ClaudeGatewaySignInProgress,
  type ClaudeGatewaySignInStep,
} from "@pwragent/shared/contracts/claude-gateway";
import type { DesktopApi } from "../../lib/desktop-api";
import { useModalDialog } from "../../lib/useModalDialog";
import { PendingSpinner } from "../../components/PendingSpinner";

const QUESTION_FALLBACKS = {
  url_input: { title: "Sign in to this gateway?", confirm: "Sign in" },
  trust_prompt: { title: "Trust this gateway?", confirm: "Yes, trust this gateway" },
  confirm_account: { title: "Is this your account?", confirm: "Yes, continue" },
} as const;

function errorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  // Electron prefixes errors thrown by a main-process handler.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/**
 * Shows the steps of Claude Code's gateway sign-in and passes on the
 * operator's answers. Claude Code writes the titles and warnings; PwrAgent
 * only supplies wording it leaves out. Closing the dialog cancels.
 */
export function ClaudeGatewaySignInDialog(props: {
  desktopApi: DesktopApi;
  /** From the `start` call, made by the button so a remount cannot start twice. */
  initial: ClaudeGatewaySignInProgress;
  gatewayUrl: string;
  onDone: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const [progress, setProgress] = useState(props.initial);
  const [answeredRevision, setAnsweredRevision] = useState<number>();
  const [failure, setFailure] = useState<string>();
  const apiRef = useRef(props.desktopApi);
  apiRef.current = props.desktopApi;
  const onDoneRef = useRef(props.onDone);
  onDoneRef.current = props.onDone;
  const id = progress.id;
  const step: ClaudeGatewaySignInStep = progress.step;
  const finished = isClaudeGatewaySignInFinished(step);

  useEffect(() => {
    let live = true;
    let after = props.initial.revision;
    void (async () => {
      while (live) {
        const result = await apiRef.current.claudeGateway?.({ action: "wait", id, after });
        if (!live || !result?.progress) return;
        after = result.progress.revision;
        setProgress(result.progress);
        if (isClaudeGatewaySignInFinished(result.progress.step)) {
          if (result.progress.step.state === "done") onDoneRef.current();
          return;
        }
      }
    })().catch((caught: unknown) => {
      if (live) setFailure(errorMessage(caught));
    });
    return () => { live = false; };
  }, [id, props.initial.revision]);

  const cancel = () => {
    if (!finished) void apiRef.current.claudeGateway?.({ action: "cancel", id }).catch(() => {});
    props.onClose();
  };
  const ref = useModalDialog({ onClose: cancel });

  const answer = async () => {
    setAnsweredRevision(progress.revision);
    try {
      await apiRef.current.claudeGateway?.({ action: "answer", id, revision: progress.revision });
    } catch (caught) {
      setFailure(errorMessage(caught));
    }
  };

  let body: ReactNode;
  let actions: ReactNode;
  let title: string;
  if (failure || step.state === "error") {
    title = "Gateway sign-in did not finish";
    const message = failure ?? (step.state === "error" ? step.message : "");
    const detail = !failure && step.state === "error" ? step.detail : undefined;
    body = (
      <div className="claude-gateway-dialog__error" role="alert">
        <strong>{message}</strong>
        {detail && detail !== message ? <span>{detail}</span> : null}
      </div>
    );
    actions = (
      <>
        <button className="button button--secondary" type="button" onClick={props.onClose}>Close</button>
        <button className="button button--primary" type="button" onClick={props.onRetry}>Try again</button>
      </>
    );
  } else if (step.state === "url_input" || step.state === "trust_prompt" || step.state === "confirm_account") {
    const fallback = QUESTION_FALLBACKS[step.state];
    title = step.title ?? fallback.title;
    const waiting = answeredRevision === progress.revision;
    body = (
      <>
        {step.detail ? <p>{step.detail}</p> : null}
        <div className="claude-gateway-dialog__shown">
          {step.shownLabel ? <span className="claude-gateway-dialog__shown-label">{step.shownLabel}</span> : null}
          <span className="claude-gateway-dialog__shown-value">{step.shown}</span>
        </div>
      </>
    );
    actions = (
      <>
        <button className="button button--secondary" type="button" onClick={cancel}>{step.cancelLabel ?? "Cancel sign-in"}</button>
        <button className="button button--primary" type="button" disabled={waiting} onClick={() => { void answer(); }}>
          {step.confirmLabel ?? fallback.confirm}
        </button>
      </>
    );
  } else if (step.state === "polling") {
    title = "Finish signing in in your browser";
    const link = step.browserUrl ?? step.verificationUri;
    body = (
      <>
        <p>{step.detail ?? "Sign in on the gateway's page in your browser."}</p>
        {step.userCode ? (
          <div className="claude-gateway-dialog__code" aria-label="Verification code">{step.userCode}</div>
        ) : null}
        <p className="claude-gateway-dialog__waiting" role="status">
          <PendingSpinner pairing="paired" size="sm" />
          Waiting for the gateway…
        </p>
      </>
    );
    actions = (
      <>
        <button className="button button--secondary" type="button" onClick={cancel}>Cancel sign-in</button>
        {link && props.desktopApi.copyText ? (
          <button className="button button--secondary" type="button"
            onClick={() => { void props.desktopApi.copyText?.(link).catch(() => {}); }}>
            Copy link
          </button>
        ) : null}
        {link ? (
          <button className="button button--secondary" type="button"
            onClick={() => { void apiRef.current.claudeGateway?.({ action: "openBrowser", id }).catch(() => {}); }}>
            Open page again
          </button>
        ) : null}
      </>
    );
  } else {
    title = step.state === "done" ? "Signed in to the gateway" : "Connecting to the gateway…";
    body = (
      <p className="claude-gateway-dialog__waiting" role="status">
        {step.state === "done" ? null : <PendingSpinner pairing="paired" size="sm" />}
        {step.state === "saving" ? "Saving the sign-in…" : step.state === "done" ? "" : props.gatewayUrl}
      </p>
    );
    actions = (
      <button className="button button--secondary" type="button" onClick={cancel}>
        {step.state === "done" || step.state === "cancelled" ? "Close" : "Cancel sign-in"}
      </button>
    );
  }

  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        className="settings-confirm-dialog claude-gateway-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={ref}
        tabIndex={-1}
      >
        <p className="claude-gateway-dialog__eyebrow">Claude gateway sign-in</p>
        <h2 id={headingId}>{title}</h2>
        {body}
        <div className="settings-confirm-dialog__actions">{actions}</div>
      </div>
    </div>
  );
}

/** Confirms leaving the gateway, which also changes Claude Code in a terminal. */
export function ClaudeGatewayStopDialog(props: {
  gatewayUrl?: string;
  /** Signed in through the gateway, so stopping also signs Claude Code out. */
  signedIn: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const headingId = useId();
  const ref = useModalDialog({ onClose: () => { if (!props.busy) props.onCancel(); } });
  let host = props.gatewayUrl;
  try {
    if (props.gatewayUrl) host = new URL(props.gatewayUrl).host;
  } catch {
    // Show the setting as written.
  }
  return (
    <div className="settings-confirm-modal" role="presentation">
      <div className="settings-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} ref={ref} tabIndex={-1}>
        <h2 id={headingId}>Stop using the gateway?</h2>
        {props.signedIn ? (
          <p>
            Claude Code signs out{host ? <> of <strong>{host}</strong></> : null}, and the gateway is removed
            from Claude Code’s settings. Claude Code in your terminal stops using it too. Then sign in with your
            Claude account.
          </p>
        ) : (
          <p>
            The gateway{host ? <> <strong>{host}</strong></> : null} is removed from Claude Code’s settings, so
            Claude Code in your terminal stops using it too. Your Claude account sign-in is kept.
          </p>
        )}
        {props.error ? <p className="settings-row__error" role="alert">{props.error}</p> : null}
        <div className="settings-confirm-dialog__actions">
          <button className="button button--secondary" type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button className="button button--primary" type="button" disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? "Signing out…" : "Stop using gateway"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { errorMessage as claudeGatewayErrorMessage };
