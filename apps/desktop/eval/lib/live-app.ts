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

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "../..");
const mainEntry = path.join(desktopRoot, "out/main/index.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
    cleanup,
  };
}
