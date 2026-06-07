/**
 * Launches the REAL PwrAgent app for the smoke eval — no mocked app-server, no
 * replay fixture. Isolation is via `PWRAGENT_HOME` (a throwaway profile root),
 * NOT `HOME`: the real `HOME` is preserved so Codex (`~/.codex`) and the ACP
 * agents (`~/.gemini`, `~/.qwen`, `~/.kimi-code`, `~/.grok`) all keep their
 * real auth. Your real PwrAgent profile + thread list are never touched.
 *
 * Also clones the repo-under-test at a pinned SHA into a throwaway working dir
 * so full-access command runs never touch your real checkout, and turns on
 * protocol capture so each run banks raw ACP `session/update` transcripts for
 * the Phase B / KTD-P3 replay harness.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { applyDesktopSettingsPatch } from "../../src/main/settings/desktop-config";
import { listCodexEnvironmentOptions } from "../../src/main/app-server/codex-environment-config";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "../..");
const mainEntry = path.join(desktopRoot, "out/main/index.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Optionally run a one-time setup in the clone before launching — so the
 * agents don't each burn tokens running `pnpm install`. Two knobs:
 *   - EVAL_SETUP_ENV=<name>  run a repo Codex environment's setup script
 *     (read from <clone>/.codex/environments/*.toml). Benefits ALL backends,
 *     since they share the clone cwd — even though the env itself is Codex-only.
 *   - EVAL_SETUP_CMD="<cmd>"  run an explicit shell command instead.
 * Runs in a login shell in the clone so PATH/pnpm resolve.
 */
async function runCloneSetup(clonePath: string): Promise<void> {
  const explicit = process.env.EVAL_SETUP_CMD?.trim();
  const envName = process.env.EVAL_SETUP_ENV?.trim();
  let script = explicit || undefined;
  let label = explicit ? "EVAL_SETUP_CMD" : undefined;

  if (!script && envName) {
    const envs = await listCodexEnvironmentOptions(clonePath);
    const match = envs.find(
      (e) =>
        e.name.toLowerCase() === envName.toLowerCase() ||
        e.id.toLowerCase() === envName.toLowerCase(),
    );
    if (!match) {
      const have = envs.map((e) => e.name).join(", ") || "(none)";
      throw new Error(
        `EVAL_SETUP_ENV="${envName}" not found in ${clonePath}/.codex/environments (have: ${have})`,
      );
    }
    if (!match.setupScript) {
      console.log(`  setup env "${match.name}" has no setup script — skipping`);
      return;
    }
    script = match.setupScript;
    label = `env:${match.name}`;
  }

  if (!script) return;
  const timeoutMs = Number(process.env.EVAL_SETUP_TIMEOUT_MS ?? 900_000);
  console.log(`  running clone setup (${label}) in ${clonePath} …`);
  execFileSync("bash", ["-lc", script], {
    cwd: clonePath,
    stdio: "inherit",
    timeout: timeoutMs,
  });
  console.log("  clone setup complete");
}

export type LiveApp = {
  electronApp: ElectronApplication;
  page: Page;
  /** Throwaway PwrAgent profile root (PWRAGENT_HOME). */
  pwragentHome: string;
  /** Cloned repo-under-test working dir (PwrAgent-Test). */
  clonePath: string;
  /** Where protocol-capture JSONL transcripts are written (for KTD-P3). */
  capturesDir: string;
  /** Resolved SHA the clone was checked out at. */
  sha: string;
  /**
   * Focus a thread in the renderer — same path the app uses for menu / deep-
   * link navigation (`window:show-thread` → `navigation.showThread`). We create
   * threads via IPC, which doesn't auto-navigate the UI the way clicking "Start
   * thread" does, so call this to make each thread render live (transcript +
   * approval prompts) and watchable.
   */
  focusThread: (backend: string, threadId: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

export async function launchLiveApp(opts?: {
  /** Repo to clone. Defaults to the repo this script lives in. */
  repoRoot?: string;
  /** Commit to check out in the clone. Defaults to EVAL_SHA env or HEAD. */
  sha?: string;
  /** Keep the temp dirs on cleanup (for debugging). Default false. */
  keepTemp?: boolean;
}): Promise<LiveApp> {
  const repoRoot =
    opts?.repoRoot ?? git(desktopRoot, ["rev-parse", "--show-toplevel"]);
  const sha =
    opts?.sha ??
    (process.env.EVAL_SHA?.trim() || git(repoRoot, ["rev-parse", "HEAD"]));

  const tmpBase = mkdtempSync(path.join(os.tmpdir(), "pwragent-eval-"));
  const pwragentHome = path.join(tmpBase, "pwragent-home");
  const capturesDir = path.join(tmpBase, "captures");
  const clonePath = path.join(tmpBase, "PwrAgent-Test");
  mkdirSync(pwragentHome, { recursive: true });
  mkdirSync(capturesDir, { recursive: true });

  // Clone the repo-under-test at the pinned SHA (local clone = fast + offline).
  // node_modules isn't tracked, so the clone is light; the point is to give the
  // agents a real git repo to reason about and a throwaway dir to act in.
  git(tmpBase, ["clone", "--quiet", "--no-hardlinks", repoRoot, clonePath]);
  git(clonePath, ["checkout", "--quiet", sha]);

  // Optional one-time setup (e.g. install deps) so agents don't each do it.
  await runCloneSetup(clonePath);

  // Seed the `default` profile so boot opens straight into it with no wizard.
  applyDesktopSettingsPatch(
    path.join(pwragentHome, "profiles/default/config.toml"),
    {
      general: {
        confirmQuitWithInProgressThreads: false,
        appearance: { theme: "dark", density: "mission-control" },
      },
      onboarding: { completed: true },
    },
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    // Isolate PwrAgent state to the throwaway root; leave HOME real so agent
    // + Codex auth resolves from the user's real home.
    PWRAGENT_HOME: pwragentHome,
    NODE_ENV: "production",
    PWRAGENT_CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS: "30000",
    // Bank raw ACP/Codex JSON-RPC transcripts for the KTD-P3 replay harness.
    PWRAGENT_PROTOCOL_CAPTURE: "1",
    PWRAGENT_PROTOCOL_CAPTURE_ROOT: capturesDir,
  });
  // Never run the mocked replay driver — we want the real app-server.
  delete env.PWRAGENT_REPLAY_FIXTURE_PATH;
  delete env.ELECTRON_RENDERER_URL;

  const electronApp = await electron.launch({
    args: [mainEntry],
    cwd: desktopRoot,
    env,
  });
  const page = await electronApp.firstWindow();

  const focusThread = async (backend: string, threadId: string): Promise<void> => {
    // Run in the MAIN process and push the existing `window:show-thread`
    // channel to the renderer — the renderer's onShowThreadRequested handler
    // switches to the thread view and selects it, exactly like a menu/deep-link
    // navigation. Channel literal mirrors WINDOW_SHOW_THREAD_CHANNEL.
    await electronApp
      .evaluate(
        ({ BrowserWindow }, req) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send("window:show-thread", req);
            }
          }
        },
        { backend, threadId },
      )
      .catch(() => undefined);
  };

  const cleanup = async (): Promise<void> => {
    await electronApp.close().catch(() => undefined);
    if (!opts?.keepTemp) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  };

  return {
    electronApp,
    page,
    pwragentHome,
    clonePath,
    capturesDir,
    sha,
    focusThread,
    cleanup,
  };
}
