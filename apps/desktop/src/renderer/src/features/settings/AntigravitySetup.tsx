import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AcpAgentSettingsEntry } from "@pwragent/shared/contracts/backend";
import type { AntigravityRuntimeStatus, AntigravitySetupRequest, AntigravitySetupResult } from "../../../../shared/antigravity-setup";
import type { DesktopApi } from "../../lib/desktop-api";
import { ManagedRuntimeProgressStrip, useManagedRuntimeProgress } from "./ManagedRuntimeProgress";
import { SettingsField } from "./SettingsLayout";

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

  useEffect(() => {
    let current = true;
    void request?.({ action: "read" }).then((result) => {
      if (!current) return;
      if (result.ok) setRuntime(result.runtime);
      else setRuntimeError(result.message);
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
  const managed = runtime?.status === "installed" ? runtime.runtime : undefined;
  const installLabel = managed ? "Reinstall Antigravity" : "Install Antigravity";

  return (
    <>
      <SettingsField
        label="Runtime"
        sub="Download and verify the CLI from Google, or select an installation below."
        error={progress?.phase === "failed" ? undefined : runtimeError}
        control={
          <div className="settings-paths">
            <p className="settings-empty">
              {managed
                ? `Managed version ${managed.version} installed.`
                : entry.installed
                  ? `Detected version ${entry.version ?? "unknown"}.`
                  : "Antigravity is not installed."}
            </p>
            <div className="settings-inline-actions">
              {runtime && runtime.status !== "unsupported" ? (
                <button type="button" className="button button--secondary" disabled={installing || Boolean(step)} onClick={() => void install()}>
                  {installing ? "Installing…" : installLabel}
                </button>
              ) : null}
              <button type="button" className="button button--ghost" onClick={() => {
                void send({ action: "install-guide" }).then((result) => { if (!result.ok) setRuntimeError(result.message); });
              }}>Manual install guide</button>
            </div>
            {progress ? <ManagedRuntimeProgressStrip progress={progress} onRetry={installing || step ? undefined : () => void install()} /> : null}
          </div>
        }
      />
      {props.children}
      <SettingsField
        label="Google account"
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
                <p>Use <code>agy acp --login</code> to sign in or switch accounts. To sign out, open <code>agy</code> and run <code>/logout</code>. Select Refresh below after changing an account.</p>
              </details>
            ) : null}
          </div>
        }
      />
    </>
  );
}
