import { clipboard, ipcMain, shell, type WebContents } from "electron";
import { ANTIGRAVITY_SETUP_CHANNEL } from "../../../shared/ipc";
import type { AntigravitySetupRequest, AntigravitySetupResult } from "../../../shared/antigravity-setup";
import type { AcpLaunchDescriptor } from "../../acp/acp-launch-descriptor";
import { installManagedAntigravityRuntime, readManagedAntigravityStatus } from "../../acp/antigravity-managed-runtime";
import { AntigravitySignIn, ANTIGRAVITY_SIGN_IN_TIMEOUT_MS, type AntigravitySignInAttempt } from "../../acp/antigravity-sign-in";
import { createManagedRuntimeProgressReporter } from "../../managed-runtime-progress";

type SignIn = {
  id: string;
  owner: WebContents;
  expiresAt: number;
  command?: string;
  attempt?: AntigravitySignInAttempt;
  cancel: () => void;
};

const accepted: AntigravitySetupResult = { ok: true };
const failed = (message: string): AntigravitySetupResult => ({ ok: false, message });

export function registerAntigravitySetupIpc(options: {
  refresh: (probeCapabilities: boolean) => Promise<AcpLaunchDescriptor | undefined>;
}): () => void {
  const signIn = new AntigravitySignIn({ openExternal: (url) => shell.openExternal(url) });
  const lifecycle = new AbortController();
  let login: SignIn | undefined;
  let installing = false;

  function release(current: SignIn): void {
    current.owner.removeListener("destroyed", current.cancel);
    current.owner.removeListener("did-start-navigation", current.cancel);
    if (login === current) login = undefined;
  }

  async function install(): Promise<AntigravitySetupResult> {
    if (installing || login) return failed("An Antigravity setup action is already running.");
    installing = true;
    const progress = createManagedRuntimeProgressReporter("antigravity");
    try {
      const runtime = await installManagedAntigravityRuntime({ progress, signal: lifecycle.signal });
      progress.ready(runtime.version);
      // The install and its checksum/ACP checks have already succeeded. A
      // later discovery error does not roll back the active verified runtime.
      await options.refresh(false).catch(() => undefined);
      return { ok: true, runtime: { status: "installed", runtime } };
    } catch {
      const error = "Could not finish setting up Antigravity. Try again or install it manually.";
      if (lifecycle.signal.aborted) progress.idle();
      else progress.failed(error);
      return failed(error);
    } finally {
      installing = false;
    }
  }

  async function start(owner: WebContents, id: string): Promise<AntigravitySetupResult> {
    if (installing || login) return failed("An Antigravity setup action is already running.");
    const current: SignIn = {
      id,
      owner,
      expiresAt: Date.now() + ANTIGRAVITY_SIGN_IN_TIMEOUT_MS,
      cancel: () => {
        release(current);
        void current.attempt?.cancel();
      },
    };
    login = current;
    owner.once("destroyed", current.cancel);
    owner.once("did-start-navigation", current.cancel);
    let launch: AcpLaunchDescriptor | undefined;
    try {
      launch = await options.refresh(false);
    } catch {
      release(current);
      return failed("Could not find Antigravity. Check the active installation and try again.");
    }
    if (login !== current) return failed("Antigravity sign-in was cancelled.");
    if (!launch) {
      release(current);
      return failed("Select an Antigravity installation before signing in.");
    }
    try {
      current.expiresAt = Date.now() + ANTIGRAVITY_SIGN_IN_TIMEOUT_MS;
      current.command = launch.command;
      current.attempt = signIn.start(launch);
      await current.attempt.ready;
      return { ok: true, expiresAt: current.expiresAt };
    } catch (error) {
      release(current);
      return failed(signInError(error));
    }
  }

  async function handle(owner: WebContents, request: AntigravitySetupRequest): Promise<AntigravitySetupResult> {
    if (request?.action === "read") return { ok: true, runtime: await readManagedAntigravityStatus() };
    if (request?.action === "install") return await install();
    if (request?.action === "install-guide") {
      await shell.openExternal("https://antigravity.google/docs/cli/tutorial");
      return accepted;
    }
    if (!request || !("attemptId" in request) || typeof request.attemptId !== "string"
      || !/^[a-f0-9-]{36}$/i.test(request.attemptId)) {
      return failed("Invalid Antigravity setup request.");
    }
    if (request.action === "start") return await start(owner, request.attemptId);
    const current = login;
    if (!current || current.owner !== owner || current.id !== request.attemptId) {
      return failed("Antigravity sign-in is no longer active in this window.");
    }
    if (request.action === "cancel") {
      current.cancel();
      return accepted;
    }
    const attempt = current.attempt;
    if (!attempt) return failed("Antigravity is still preparing sign-in.");
    switch (request.action) {
      case "submit":
        attempt.submitCode(request.code);
        return accepted;
      case "reopen":
        await attempt.openPage();
        return accepted;
      case "copy-link":
        attempt.copyLink((url) => clipboard.writeText(url));
        return accepted;
      case "wait":
        try {
          await attempt.completed;
          if (login === current) await options.refresh(true).catch(() => undefined);
          return { ok: true, verifiedCommand: current.command };
        } finally {
          release(current);
        }
    }
    return failed("Invalid Antigravity setup request.");
  }

  ipcMain.removeHandler(ANTIGRAVITY_SETUP_CHANNEL);
  ipcMain.handle(ANTIGRAVITY_SETUP_CHANNEL, async (event, request: AntigravitySetupRequest) => {
    if (!event.senderFrame || event.senderFrame.parent) return failed("Antigravity setup requires the main window.");
    try {
      return await handle(event.sender, request);
    } catch (error) {
      return failed(signInError(error));
    }
  });
  return () => {
    lifecycle.abort();
    login?.cancel();
    ipcMain.removeHandler(ANTIGRAVITY_SETUP_CHANNEL);
  };
}

function signInError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if ([
    "Antigravity sign-in is already in progress.",
    "Antigravity sign-in timed out.",
    "Antigravity sign-in was cancelled.",
    "Enter the code shown on the Antigravity sign-in page.",
    "Could not open the Google sign-in page.",
    "Start Antigravity sign-in again for a new link.",
    "Antigravity could not verify sign-in by opening an ACP session.",
  ].includes(message)) return message;
  return "Could not finish Antigravity setup. Start sign-in again or use agy in your terminal.";
}
