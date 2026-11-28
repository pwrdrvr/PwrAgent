import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../../lib/desktop-api";

/**
 * Per-row Codex sign-in state. `ok` carries the email and plan Codex
 * reports so the row can confirm which account signed in.
 */
export type RowLoginState =
  | { kind: "idle" }
  /** A status check found no sign-in, and none was started from here. */
  | { kind: "signed-out"; detail?: string }
  | { kind: "starting" }
  | { kind: "waiting"; url?: string; detail?: string }
  /** `signIn`: the check is about a sign-in started from this row. */
  | { kind: "checking"; url?: string; signIn?: boolean }
  | { kind: "ok"; email?: string; planType?: string }
  | { kind: "error"; detail: string; url?: string };

export function rowLoginUrl(state: RowLoginState): string | undefined {
  return "url" in state ? state.url : undefined;
}

export function ProfileRowLoginControls(props: {
  valid: boolean;
  state: RowLoginState;
  onLogin: () => void;
  onCheck: () => void;
  onCopyUrl: () => void;
  /** Name for screen readers when several rows share one screen. */
  rowLabel?: string;
  /** Offer Check status before any sign-in started. Only for an account
   *  that already exists; a profile not yet created has nothing to check. */
  checkWhenIdle?: boolean;
}) {
  if (props.state.kind === "ok") {
    return (
      <span className="guided-setup__profile-row-status guided-setup__profile-row-status--ok">
        ✓ Logged in
      </span>
    );
  }
  const hasUrl = Boolean(rowLoginUrl(props.state));
  const inFlight =
    props.state.kind === "starting" || props.state.kind === "checking";
  const loginLabel = (() => {
    if (props.state.kind === "starting") return "Starting…";
    if (props.state.kind === "waiting") return "Re-open browser";
    if (props.state.kind === "error") return "Try again";
    if (props.state.kind === "signed-out") return "Log in";
    if (props.state.kind === "checking") return "Checking…";
    return "Log in";
  })();
  const suffix = props.rowLabel ? ` for ${props.rowLabel}` : "";
  return (
    <div className="guided-setup__profile-row-actions">
      <button
        type="button"
        className="guided-setup__btn guided-setup__btn--ghost"
        aria-label={props.rowLabel ? `${loginLabel}${suffix}` : undefined}
        disabled={!props.valid || inFlight}
        onClick={props.onLogin}
      >
        {loginLabel}
      </button>
      {hasUrl ? (
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--link"
          aria-label={props.rowLabel ? `Copy URL${suffix}` : undefined}
          onClick={props.onCopyUrl}
        >
          Copy URL
        </button>
      ) : null}
      {props.state.kind === "waiting"
      || props.state.kind === "signed-out"
      || (props.state.kind === "idle" && props.checkWhenIdle) ? (
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--link"
          aria-label={props.rowLabel ? `Check status${suffix}` : undefined}
          disabled={!props.valid}
          onClick={props.onCheck}
        >
          Check status
        </button>
      ) : null}
    </div>
  );
}

export function ProfileRowLoginStatus(props: { state: RowLoginState }) {
  if (props.state.kind === "ok") {
    const bits = [props.state.email, props.state.planType].filter(Boolean);
    return (
      <div className="guided-setup__profile-row-detail guided-setup__profile-row-detail--ok">
        {bits.length > 0 ? bits.join(" · ") : "Authenticated"}
      </div>
    );
  }
  if (props.state.kind === "waiting") {
    return (
      <div className="guided-setup__profile-row-detail">
        Browser opened. Complete the Codex sign-in, then return here — we
        re-check automatically when this window regains focus.
      </div>
    );
  }
  if (props.state.kind === "error") {
    return (
      <div className="guided-setup__profile-row-detail guided-setup__profile-row-detail--error">
        {props.state.detail}
      </div>
    );
  }
  if (props.state.kind === "signed-out") {
    return (
      <div className="guided-setup__profile-row-detail">
        Not signed in. Log in opens the Codex sign-in in your browser.
      </div>
    );
  }
  return null;
}

/**
 * Sign-in controls for one Codex auth profile (`""` is the system default,
 * `~/.codex/`). Nothing runs on mount: `codex login status` and `codex
 * login` both launch the CLI, so each waits for a click. After Log in, the
 * row re-checks when the window regains focus, which is the operator coming
 * back from the browser.
 */
export function useCodexProfileLogin(
  desktopApi: DesktopApi | undefined,
  profile: string,
  initial: RowLoginState = { kind: "idle" },
) {
  const [state, setState] = useState<RowLoginState>(initial);
  // The state belongs to one profile. When the row starts describing another
  // (the operator picked a different auth profile), the old profile's
  // "Logged in" or open browser link must not carry over to it.
  // Each start or check takes the next number, and only the newest one may
  // write its answer. A check that was already running when the operator
  // pressed Log in again, or that belongs to a profile since replaced, is
  // older news than what the row now shows.
  const requestRef = useRef(0);
  const [stateProfile, setStateProfile] = useState(profile);
  if (stateProfile !== profile) {
    setStateProfile(profile);
    setState(initial);
    requestRef.current += 1;
  }
  const apiRef = useRef(desktopApi);
  apiRef.current = desktopApi;

  const check = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (!api?.checkCodexAuthProfileStatus) return;
    const request = ++requestRef.current;
    const current = () => request === requestRef.current;
    setState((prev) =>
      prev.kind === "ok"
        ? prev
        : {
            kind: "checking",
            url: rowLoginUrl(prev),
            signIn: prev.kind === "waiting"
              || (prev.kind === "checking" && prev.signIn === true),
          },
    );
    try {
      const result = await api.checkCodexAuthProfileStatus({ profile });
      if (!current()) return;
      if (result.authenticated) {
        setState({
          kind: "ok",
          email: result.email,
          planType: result.planType,
        });
      } else {
        // Only a sign-in started from this row is something to wait for. A
        // check with none running found a signed-out profile; saying a
        // browser opened would describe something that never happened.
        setState((prev) => {
          const url = rowLoginUrl(prev);
          const signingIn = prev.kind === "waiting"
            || (prev.kind === "checking" && prev.signIn === true);
          return url !== undefined || signingIn
            ? { kind: "waiting", url, detail: result.detail }
            : { kind: "signed-out", detail: result.detail };
        });
      }
    } catch (caught) {
      if (!current()) return;
      setState({
        kind: "error",
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, [profile]);

  const start = useCallback(
    async (options?: { createProfile?: boolean }): Promise<void> => {
      const api = apiRef.current;
      if (!api?.startCodexAuthProfileLogin) return;
      const request = ++requestRef.current;
      const current = () => request === requestRef.current;
      setState({ kind: "starting" });
      try {
        if (options?.createProfile) {
          if (!api.createCodexAuthProfile) return;
          // Idempotent: an existing profile reports `created: false`.
          await api.createCodexAuthProfile({ profile });
        }
        const result = await api.startCodexAuthProfileLogin({ profile });
        if (!current()) return;
        if (result.authenticated) {
          await check();
          return;
        }
        setState({
          kind: "waiting",
          url: result.loginUrl,
          detail: result.detail,
        });
      } catch (caught) {
        if (!current()) return;
        setState({
          kind: "error",
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      }
    },
    [check, profile],
  );

  const copyUrl = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const url = rowLoginUrl(state);
    if (!url || !api?.copyText) return;
    try {
      await api.copyText(url);
    } catch {
      // Best effort; the URL is still on screen to select.
    }
  }, [state]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api?.onWindowFocus) return undefined;
    if (state.kind !== "waiting") return undefined;
    return api.onWindowFocus(() => {
      void check();
    });
  }, [check, state.kind]);

  return { state, start, check, copyUrl };
}

/**
 * One Codex account row: the label on the left, sign-in controls on the
 * right, and the status line under them.
 */
export function CodexLoginRow(props: {
  label: string;
  meta?: string;
  marker: string;
  login: ReturnType<typeof useCodexProfileLogin>;
  createProfile?: boolean;
}) {
  const { login } = props;
  return (
    <div
      className={`guided-setup__profile-row guided-setup__profile-row--has-login is-${login.state.kind}`}
    >
      <div className="guided-setup__profile-row-top">
        <span className="guided-setup__profile-num">{props.marker}</span>
        <span className="guided-setup__profile-input guided-setup__profile-input--static">
          <code>{props.label}</code>
          {props.meta ? (
            <span className="guided-setup__profile-input-meta">{props.meta}</span>
          ) : null}
        </span>
        <ProfileRowLoginControls
          valid
          checkWhenIdle
          state={login.state}
          onLogin={() => void login.start({ createProfile: props.createProfile })}
          onCheck={() => void login.check()}
          onCopyUrl={() => void login.copyUrl()}
        />
      </div>
      <ProfileRowLoginStatus state={login.state} />
    </div>
  );
}
