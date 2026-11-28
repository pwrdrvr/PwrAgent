import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AcpAgentSettingsEntry } from "@pwragent/shared/contracts/backend";
import type {
  AntigravityReleaseStatus,
  AntigravityRuntimeStatus,
  AntigravitySetupRequest,
  AntigravitySetupResult,
} from "../../../../shared/antigravity-setup";
import type { DesktopApi } from "../../lib/desktop-api";
import { acpRelativeTime } from "./acp-agent-copy";
import { antigravityRuntimeView, type AntigravityRuntimeView } from "./antigravity-runtime-view";
import { ManagedRuntimeProgressStrip, useManagedRuntimeProgress } from "./ManagedRuntimeProgress";
import { SettingsField } from "./SettingsLayout";

export const ANTIGRAVITY_RUNTIME_FIELD_ID = "settings-antigravity-runtime";
export const ANTIGRAVITY_ACCOUNT_FIELD_ID = "settings-antigravity-account";

type SignInStep = "opening" | "code" | "verifying";

export function AntigravitySetup(props: {
  desktopApi?: DesktopApi;
  entry: AcpAgentSettingsEntry;
  children: ReactNode;
  onChanged: () => void;
}) {
  const { desktopApi, entry } = props;
  const request = desktopApi?.antigravitySetup;
  const [runtime, setRuntime] = useState<AntigravityRuntimeStatus>();
  const [release, setRelease] = useState<AntigravityReleaseStatus>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [installing, setInstalling] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string>();
  const [accountError, setAccountError] = useState<string>();
  const [linkCopied, setLinkCopied] = useState(false);
  const [step, setStep] = useState<SignInStep>();
  const [verifiedCommand, setVerifiedCommand] = useState<string>();
  const [expiresAt, setExpiresAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const attempt = useRef<string | undefined>(undefined);
  const progress = useManagedRuntimeProgress(desktopApi, "antigravity");

  async function send(action: AntigravitySetupRequest): Promise<AntigravitySetupResult> {
    return await request?.(action).catch(() => ({
      ok: false, message: "Antigravity setup is unavailable. Try again.",
    })) ?? { ok: false, message: "Antigravity setup is unavailable in this build." };
  }

  async function checkForUpdates(force: boolean): Promise<void> {
    setChecking(true);
    setCheckError(undefined);
    const result = await send({ action: "check-update", force });
    setChecking(false);
    if (!result.ok) {
      setCheckError(result.message);
      return;
    }
    if (result.runtime) setRuntime(result.runtime);
    if (result.release) setRelease(result.release);
  }
  const checkForUpdatesRef = useRef(checkForUpdates);
  checkForUpdatesRef.current = checkForUpdates;

  useEffect(() => {
    let current = true;
    // Read the installed runtime first: it is local and fast. Opening this
    // page is also when an operator expects to learn about a newer release,
    // so the manifest check follows (reusing a check from the last minutes).
    void request?.({ action: "read" }).then((result) => {
      if (!current) return;
      if (result.ok) {
        setRuntime(result.runtime);
        if (result.runtime && result.runtime.status !== "unsupported") {
          void checkForUpdatesRef.current(false);
        }
      } else setRuntimeError(result.message);
    }).catch(() => {
      if (current) setRuntimeError("Could not check the managed Antigravity installation.");
    });
    return () => {
      current = false;
      const id = attempt.current;
      attempt.current = undefined;
      if (id) void request?.({ action: "cancel", attemptId: id }).catch(() => undefined);
    };
  }, [request]);

  // An install another surface started (the startup notice, another window)
  // finished: the runtime this page read still names the old release.
  const installedAt = progress?.phase === "ready" ? progress.updatedAt : undefined;
  useEffect(() => {
    if (installedAt === undefined) return;
    let current = true;
    void request?.({ action: "read" }).then((result) => {
      if (current && result.ok && result.runtime) setRuntime(result.runtime);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [installedAt, request]);

  useEffect(() => {
    if (step !== "code") return;
    const update = () => setSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt, step]);

  async function install() {
    setInstalling(true);
    setRuntimeError(undefined);
    const result = await send({ action: "install" });
    setInstalling(false);
    if (!result.ok) {
      setRuntimeError(result.message);
      return;
    }
    setRuntime(result.runtime);
    props.onChanged();
  }

  async function start() {
    const id = crypto.randomUUID();
    attempt.current = id;
    setAccountError(undefined);
    setLinkCopied(false);
    setStep("opening");
    const ready = await send({ action: "start", attemptId: id });
    if (attempt.current !== id) return;
    if (!ready.ok) {
      attempt.current = undefined;
      setStep(undefined);
      setAccountError(ready.message);
      return;
    }
    setExpiresAt(ready.expiresAt ?? 0);
    setStep("code");
    const completed = await send({ action: "wait", attemptId: id });
    if (attempt.current !== id) return;
    attempt.current = undefined;
    setStep(undefined);
    if (!completed.ok) {
      setAccountError(completed.message);
      return;
    }
    setVerifiedCommand(completed.verifiedCommand);
    props.onChanged();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("authorization-code");
    const id = attempt.current;
    if (!(field instanceof HTMLInputElement) || !id) return;
    const code = field.value.trim();
    field.value = "";
    setAccountError(undefined);
    setStep("verifying");
    const result = await send({ action: "submit", attemptId: id, code });
    if (!result.ok && attempt.current === id) {
      setStep("code");
      setAccountError(result.message);
    }
  }

  async function browserAction(action: "reopen" | "copy-link") {
    const id = attempt.current;
    if (!id) return;
    const result = await send({ action, attemptId: id });
    if (attempt.current !== id) return;
    if (!result.ok) setAccountError(result.message);
    else if (action === "copy-link") setLinkCopied(true);
  }

  function cancel() {
    const id = attempt.current;
    attempt.current = undefined;
    setStep(undefined);
    setAccountError(undefined);
    if (id) void send({ action: "cancel", attemptId: id });
  }

  if (!request) return props.children;
  const verified = Boolean(verifiedCommand && verifiedCommand === entry.activeCommand);
  const accessConfirmed = Boolean(entry.lastDiscoveredAt && !entry.lastDiscoveryError);
  const needsSignIn = entry.installed && Boolean(entry.unavailableReason);
  const view = antigravityRuntimeView({ runtime, release, entry });
  const openGuide = () => {
    void send({ action: "install-guide" }).then((result) => { if (!result.ok) setRuntimeError(result.message); });
  };

  return (
    <>
      <SettingsField
        label="Runtime"
        fieldId={ANTIGRAVITY_RUNTIME_FIELD_ID}
        sub="PwrAgent downloads Antigravity from Google, verifies its checksum and ACP startup, and checks for a newer release when you open this page."
        error={progress?.phase === "failed" ? undefined : runtimeError ?? checkError}
        control={
          <div className="settings-paths">
            {progress ? (
              <ManagedRuntimeProgressStrip progress={progress} onRetry={installing || step ? undefined : () => void install()} />
            ) : null}
            {/* A failed strip stays until the next attempt, so the status line
                and the manual install guide stay beside it. */}
            {!progress || progress.phase === "failed" ? (
              <AntigravityRuntimeStatusLine
                view={view}
                busy={installing || Boolean(step)}
                checking={checking}
                onInstall={() => void install()}
                onCheckForUpdates={() => void checkForUpdates(true)}
                onOpenGuide={openGuide}
              />
            ) : null}
          </div>
        }
      />
      {props.children}
      <SettingsField
        label="Google account"
        fieldId={ANTIGRAVITY_ACCOUNT_FIELD_ID}
        sub="Sign in with Google to use Antigravity and discover the models available to your account."
        error={accountError}
        control={
          <div className="settings-paths">
            {step === "code" ? (
              <form className="settings-paths" autoComplete="off" onSubmit={(event) => void submit(event)}>
                <p>Finish signing in with Google, then paste the code from the browser. This link expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}.</p>
                <label>
                  Authorization code
                  <input name="authorization-code" type="password" className="settings-input" autoComplete="off" spellCheck={false} required maxLength={2048} />
                </label>
                <div className="settings-inline-actions">
                  <button type="submit" className="button button--primary">Verify code</button>
                  <button type="button" className="button button--secondary" onClick={() => void browserAction("reopen")}>Reopen browser</button>
                  <button type="button" className="button button--ghost" onClick={() => void browserAction("copy-link")}>{linkCopied ? "Copied" : "Copy sign-in link"}</button>
                </div>
              </form>
            ) : (
              <p className="settings-empty" role="status">
                {step === "opening" ? "Opening Google sign-in…"
                  : step === "verifying" ? "Verifying Google sign-in and checking available models…"
                  : verified ? "Google sign-in verified."
                  : accessConfirmed ? "Antigravity access verified."
                  : needsSignIn ? "Google sign-in required."
                  : entry.installed ? "Account access has not been verified."
                  : "Install Antigravity to sign in."}
              </p>
            )}
            <div className="settings-inline-actions">
              {step ? <button type="button" className="button button--ghost" onClick={cancel}>Cancel sign-in</button>
                : entry.installed && (!verified && !accessConfirmed || accountError)
                  ? <button type="button" className="button button--secondary" disabled={installing} onClick={() => void start()}>Sign in with Google</button>
                  : null}
            </div>
            {entry.installed && !step ? (
              <details>
                <summary>Manage your account in Terminal</summary>
                <p>Use <code>agy acp --login</code> to sign in or switch accounts. To sign out, open <code>agy</code> and run <code>/logout</code>. Select Check again in Setup after changing an account.</p>
              </details>
            ) : null}
          </div>
        }
      />
    </>
  );
}

/**
 * The managed runtime reported the way the Grok and Codex PwrAgent builds
 * are: which version is in use, whether Google has a newer one, when PwrAgent
 * last asked, and the one action that moves it forward. Reinstall stays
 * available, but only once there is nothing newer to install.
 */
export function AntigravityRuntimeStatusLine(props: {
  view: AntigravityRuntimeView;
  busy: boolean;
  checking: boolean;
  onInstall: () => void;
  onCheckForUpdates: () => void;
  onOpenGuide: () => void;
}) {
  const { view } = props;
  const checkedAt = view.kind === "installed" || view.kind === "not-installed" ? view.checkedAt : undefined;
  const checked = checkedAt !== undefined ? ` · checked ${acpRelativeTime(checkedAt)}` : "";
  let line: ReactNode;
  switch (view.kind) {
    case "loading":
      line = <span className="acp-build__state">Reading the managed installation…</span>;
      break;
    case "unsupported":
      line = (
        <span className="acp-build__state">
          PwrAgent can install Antigravity on Apple Silicon Macs. Use the manual install guide on this computer.
        </span>
      );
      break;
    case "not-installed":
      line = (
        <>
          <span className="status-dot" aria-hidden="true" />
          <span className="acp-build__state">
            {view.detectedVersion
              ? `Not installed by PwrAgent · using your Antigravity ${view.detectedVersion}`
              : "Antigravity is not installed."}
            {view.latestVersion ? ` · Google's current release is ${view.latestVersion}` : ""}
            {checked}
          </span>
        </>
      );
      break;
    case "installed": {
      const state = [
        view.inUse
          ? "in use"
          : view.notInUseReason === "disabled"
            ? "installed · Antigravity is off"
            : view.notInUseReason === "other-install"
              ? "installed · not in use, another Antigravity install is active"
              : "installed",
        ...(view.updateAvailable
          ? [`${view.latestVersion} available from Google`]
          : view.latestVersion ? ["up to date"] : []),
      ].join(" · ");
      line = (
        <>
          <span
            className={`status-dot${view.inUse && !view.updateAvailable ? " status-dot--ok" : " status-dot--warning"}`}
            aria-hidden="true"
          />
          <span className="acp-build__tag">{view.version}</span>
          <span className="acp-build__state">{state}{checked}</span>
        </>
      );
      break;
    }
  }
  const canInstall = view.kind === "installed" || view.kind === "not-installed";
  const latest = canInstall ? view.latestVersion : undefined;
  const offerInstall = view.kind === "not-installed" || (view.kind === "installed" && view.updateAvailable);
  return (
    <div className="acp-build">
      <p className="acp-build__line" role="status">{line}</p>
      <div className="settings-inline-actions">
        {offerInstall ? (
          <button type="button" className="button button--primary" disabled={props.busy} onClick={props.onInstall}>
            {props.busy
              ? "Installing…"
              : view.kind === "installed"
                ? `Update to ${latest}`
                : `Install Antigravity${latest ? ` ${latest}` : ""}`}
          </button>
        ) : null}
        {canInstall ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={props.busy || props.checking}
            onClick={props.onCheckForUpdates}
          >
            {props.checking ? "Checking…" : "Check for updates"}
          </button>
        ) : null}
        {view.kind === "installed" && !view.updateAvailable ? (
          <button type="button" className="button button--ghost" disabled={props.busy} onClick={props.onInstall}>
            {props.busy ? "Installing…" : "Reinstall"}
          </button>
        ) : null}
        <button type="button" className="button button--ghost" onClick={props.onOpenGuide}>Manual install guide</button>
      </div>
    </div>
  );
}
