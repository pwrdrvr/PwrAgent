import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import type {
  RunWorktreeReflinkResponse,
  WorktreeReflinkCapabilities,
  WorktreeReflinkRuntime,
  WorktreeReflinkSummary,
} from "@pwragent/shared/contracts/worktree-reflink";
import { buildPwrAgentChildProcessEnv } from "./child-process-env";
import { getSelectedManagedGit } from "./git-command";
import { gitCommandPreference, gitRuntimeEnvironment, resolveRuntimeGitExecutable } from "./git-runtime";
import { terminateOwnedProcessTree } from "./process-tree";
import {
  WorktreeReflinkCapabilityProbe,
  type GitRuntimeIdentity,
} from "./git-worktree-reflink-capabilities";

export type WorktreeReflinkMode = "estimate" | "share";

export type WorktreeReflinkPlan =
  | { ok: true; args: string[]; verifiedFilters: boolean }
  | { ok: false; reason: "no-reflink" | "no-verify-filters" };

/**
 * The arguments for one run. Two rules live here and nowhere else:
 *
 * - An estimate is Git's dry run and never carries `--verify-filters`. Git
 *   refuses the pair, and an estimate must not run a repository's filters.
 * - `--verify-filters` is passed only for a share that asked for it with an
 *   explicit `true`, to a Git whose help lists the option. Asking a Git
 *   without it is refused, not quietly run without verification.
 */
export function planWorktreeReflink(params: {
  mode: WorktreeReflinkMode;
  verifyFilters?: boolean;
  capabilities: WorktreeReflinkCapabilities;
}): WorktreeReflinkPlan {
  if (!params.capabilities.reflink) return { ok: false, reason: "no-reflink" };
  const args = ["worktree", "reflink", "--porcelain", "-z"];
  if (params.mode === "estimate") {
    return { ok: true, args: [...args, "--dry-run"], verifiedFilters: false };
  }
  if (params.verifyFilters !== true) return { ok: true, args, verifiedFilters: false };
  if (!params.capabilities.verifyFilters) return { ok: false, reason: "no-verify-filters" };
  return { ok: true, args: [...args, "--verify-filters"], verifiedFilters: true };
}

const SUMMARY_FIELDS: Record<string, keyof WorktreeReflinkSummary> = {
  "scanned": "scanned",
  "eligible": "eligible",
  "already-shared": "alreadyShared",
  "reshared": "reshared",
  "skipped": "skipped",
  "failed": "failed",
  "observed-private-reduction": "observedPrivateReduction",
  "potential-private-reduction": "potentialPrivateReduction",
  "allocation-unknown": "allocationUnknown",
};

const REQUIRED_SUMMARY_FIELDS = ["scanned", "eligible", "already-shared", "reshared", "skipped", "failed"];

export type WorktreeReflinkOutcome = {
  /** False when Git reports that the filesystem cannot share in place. */
  supported: boolean;
  summary: WorktreeReflinkSummary;
};

function emptySummary(): WorktreeReflinkSummary {
  return {
    scanned: 0,
    eligible: 0,
    alreadyShared: 0,
    reshared: 0,
    skipped: 0,
    failed: 0,
    observedPrivateReduction: 0,
    potentialPrivateReduction: 0,
    allocationUnknown: 0,
  };
}

/**
 * Reads `git worktree reflink --porcelain -z` as it streams. Git prints one
 * record per indexed path, which is megabytes for a large worktree, so only
 * the header and the `summary` record are kept.
 *
 * A record is NUL-terminated `name value` fields ending at an empty field.
 * Its first field names its kind: `reflink 1`, `path <name>`, or `summary`.
 */
export class WorktreeReflinkOutputReader {
  private pending = "";
  private kind: "header" | "summary" | "other" | undefined;
  private backend: string | undefined;
  private readonly seen = new Set<string>();
  private readonly summary = emptySummary();

  push(chunk: string): void {
    const fields = (this.pending + chunk).split("\0");
    this.pending = fields.pop() ?? "";
    for (const field of fields) this.field(field);
  }

  private field(field: string): void {
    if (field === "") {
      this.kind = undefined;
      return;
    }
    if (this.kind === undefined) {
      this.kind = field === "summary" ? "summary" : field === "reflink 1" ? "header" : "other";
      return;
    }
    if (this.kind === "other") return;
    const space = field.indexOf(" ");
    const name = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? "" : field.slice(space + 1);
    if (this.kind === "header") {
      if (name === "backend") this.backend = value;
      return;
    }
    const key = SUMMARY_FIELDS[name];
    // Git prints these with PRIuMAX. Anything else is not this format.
    if (!key || !/^\d+$/.test(value)) return;
    this.summary[key] = Number(value);
    this.seen.add(name);
  }

  finish(): WorktreeReflinkOutcome {
    if (this.backend === undefined) {
      throw new Error("Git did not report a worktree sharing result.");
    }
    if (this.backend === "unsupported") return { supported: false, summary: emptySummary() };
    if (REQUIRED_SUMMARY_FIELDS.some((name) => !this.seen.has(name))) {
      throw new Error("Git stopped before it reported a worktree sharing summary.");
    }
    return { supported: true, summary: { ...this.summary } };
  }
}

export type WorktreeReflinkServiceDependencies<Identity extends GitRuntimeIdentity> = {
  probe: Pick<WorktreeReflinkCapabilityProbe<Identity>, "read">;
  /** Runs that identity's own executable in `cwd`, streaming its stdout. */
  run: (
    identity: Identity,
    cwd: string,
    args: string[],
    onStdout: (chunk: string) => void,
  ) => Promise<void>;
};

export const WORKTREE_TURN_RUNNING_REASON =
  "A turn is running in this worktree. Share its storage when the turn finishes.";
export const WORKTREE_BUSY_UNKNOWN_REASON =
  "PwrAgent could not check whether a turn is running in this worktree. Try again.";

function runtimeOf(result: { identity: GitRuntimeIdentity; capabilities: WorktreeReflinkCapabilities }): WorktreeReflinkRuntime {
  return { capabilities: result.capabilities, runtimeKey: result.identity.key };
}

export class WorktreeReflinkService<Identity extends GitRuntimeIdentity = GitRuntimeIdentity> {
  private readonly sharing = new Set<string>();

  constructor(private readonly dependencies: WorktreeReflinkServiceDependencies<Identity>) {}

  /** `directories`: the target first, then other repositories to ask in its place. */
  async readCapabilities(directories: string | readonly string[]): Promise<WorktreeReflinkRuntime> {
    return runtimeOf(await this.dependencies.probe.read(directories));
  }

  /**
   * The capabilities are read again for the Git selected now, and the run
   * uses the executable that answered. A share made for another Git (the
   * `runtimeKey` the operator's choices were shown against) does not run:
   * an option ticked for one Git is not consent for the next.
   *
   * A share replaces files, which races anything else writing them. `isBusy`
   * says whether a turn is running in the worktree, in any thread; a share
   * does not start while one is. An estimate changes nothing and always runs.
   */
  async run(params: {
    cwd: string;
    mode: WorktreeReflinkMode;
    verifyFilters?: boolean;
    runtimeKey: string;
    isBusy?: () => Promise<boolean>;
  }): Promise<RunWorktreeReflinkResponse> {
    const probed = await this.dependencies.probe.read(params.cwd);
    const runtime = runtimeOf(probed);
    if (!probed.answered) {
      return {
        status: "failed",
        reason: probed.identity.executable
          ? "The selected Git could not be run in this worktree."
          : "The selected Git is unavailable.",
      };
    }
    if (params.mode === "share" && probed.identity.key !== params.runtimeKey) {
      return { status: "runtime-changed", ...runtime };
    }
    const plan = planWorktreeReflink({
      mode: params.mode,
      verifyFilters: params.verifyFilters,
      capabilities: probed.capabilities,
    });
    if (!plan.ok) {
      return {
        status: "failed",
        reason: plan.reason === "no-reflink"
          ? "The selected Git cannot share worktree storage."
          : "The selected Git cannot verify filtered files.",
      };
    }
    if (params.mode === "share") {
      if (this.sharing.has(params.cwd)) {
        return { status: "failed", reason: "This worktree's storage is already being shared." };
      }
      this.sharing.add(params.cwd);
    }
    try {
      // Checked after the claim above, so two shares cannot both pass it.
      if (params.mode === "share" && params.isBusy) {
        let busy: boolean;
        try {
          busy = await params.isBusy();
        } catch {
          // Not knowing is not a reason to replace files under a turn.
          return { status: "failed", reason: WORKTREE_BUSY_UNKNOWN_REASON };
        }
        if (busy) return { status: "failed", reason: WORKTREE_TURN_RUNNING_REASON };
      }
      const reader = new WorktreeReflinkOutputReader();
      let outcome: WorktreeReflinkOutcome;
      try {
        await this.dependencies.run(probed.identity, params.cwd, plan.args, (chunk) => reader.push(chunk));
        outcome = reader.finish();
      } catch (error) {
        // Git exits non-zero when a path failed, after printing the summary
        // that counts it. Without a summary the run itself failed.
        if (typeof (error as { exitCode?: unknown })?.exitCode !== "number") throw error;
        try {
          outcome = reader.finish();
        } catch {
          throw error;
        }
      }
      return {
        status: "completed",
        mode: params.mode,
        verifiedFilters: plan.verifiedFilters,
        ...outcome,
        ...runtime,
      };
    } catch (error) {
      return { status: "failed", reason: describeGitFailure(error) };
    } finally {
      if (params.mode === "share") this.sharing.delete(params.cwd);
    }
  }
}

/** Git's own last complaint, without the command line PwrAgent built. */
function describeGitFailure(error: unknown): string {
  const stderr = typeof (error as { stderr?: unknown })?.stderr === "string"
    ? (error as { stderr: string }).stderr
    : "";
  const line = stderr.split(/\r?\n/).map((entry) => entry.trim())
    .filter((entry) => /^(fatal|error):/.test(entry)).pop();
  if (line) return line.replace(/^(fatal|error):\s*/, "");
  return error instanceof Error && error.message ? error.message : "Git could not share this worktree's storage.";
}

type RuntimeGitIdentity = GitRuntimeIdentity & { env?: NodeJS.ProcessEnv };

function selectionKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([gitCommandPreference(env) ?? null, getSelectedManagedGit() ?? null]);
}

function runtimeKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/**
 * The selected Git: what Settings names, the executable that resolves to, and
 * that file's size, time and inode, so a release installed over the same path
 * is a different Git. The environment is built in the same turn the selection
 * is confirmed, so it belongs to this executable.
 */
async function identifySelectedGit(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeGitIdentity> {
  let selection = selectionKey(env);
  for (let attempt = 0; ; attempt += 1) {
    let executable: string | undefined;
    let file: unknown[] = [];
    let failure: string | undefined;
    try {
      executable = await resolveRuntimeGitExecutable(env);
      const stats = await stat(executable, { bigint: true });
      file = [stats.size.toString(), stats.mtimeNs.toString(), stats.ino.toString()];
    } catch (error) {
      executable = undefined;
      failure = error instanceof Error ? error.message : String(error);
    }
    const current = selectionKey(env);
    // Bounded: a selection that never holds still resolves to its last answer,
    // and the probe's own before-and-after check rejects it.
    if (current !== selection && attempt < 3) {
      selection = current;
      continue;
    }
    if (!executable) return { key: runtimeKey(["unavailable", selection, failure]) };
    return {
      key: runtimeKey(["git", selection, executable, file]),
      executable,
      env: {
        ...gitRuntimeEnvironment(buildPwrAgentChildProcessEnv(env)),
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    };
  }
}

const HELP_TIMEOUT_MS = 10_000;
/** Sharing reads every candidate file twice; a large worktree takes minutes. */
const RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_STDERR_CHARS = 16 * 1024;

async function readSelectedGitHelp(identity: RuntimeGitIdentity, cwd: string): Promise<string> {
  const executable = identity.executable;
  if (!executable) throw new Error("The selected Git is unavailable.");
  return await new Promise<string>((resolve, reject) => {
    execFile(executable, ["-C", cwd, "worktree", "reflink", "-h"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      // Git translates "usage:" and its descriptions. The rows are matched
      // in the untranslated form, whatever the operator's locale.
      env: { ...identity.env, LC_ALL: "C", LANGUAGE: "C" },
      maxBuffer: 256 * 1024,
      timeout: HELP_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      // Git exits 129 for `-h` in some versions and 0 in others. Only a Git
      // that never ran, or was stopped, has no help to read.
      if (error && (typeof error.code !== "number" || error.killed)) {
        reject(error);
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

async function runSelectedGit(
  identity: RuntimeGitIdentity,
  cwd: string,
  args: string[],
  onStdout: (chunk: string) => void,
): Promise<void> {
  const executable = identity.executable;
  if (!executable) throw new Error("The selected Git is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["-C", cwd, ...args], {
      cwd: os.tmpdir(),
      // Its own process group, so a stop reaches the Git it re-executes for
      // another worktree and the filters that Git runs.
      detached: process.platform !== "win32",
      env: identity.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      termination = process.platform === "win32"
        ? Promise.resolve().then(() => { child.kill(); })
        : terminateOwnedProcessTree(child, { gracefulTimeoutMs: 250, forceTimeoutMs: 1_000 });
      termination.catch(() => undefined);
    }, RUN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // Settle once the whole group is gone, so a second share cannot
        // start beside a filter this one left running.
        const failure = new Error("Git took too long to share this worktree's storage.");
        void (termination ?? Promise.resolve()).catch(() => undefined).then(() => reject(failure));
      } else if (code !== 0) {
        reject(Object.assign(new Error(`Git exited with code ${code}.`), { exitCode: code ?? undefined, stderr }));
      } else {
        resolve();
      }
    });
  });
}

let service: WorktreeReflinkService<RuntimeGitIdentity> | undefined;

export function getWorktreeReflinkService(): WorktreeReflinkService<RuntimeGitIdentity> {
  service ??= new WorktreeReflinkService({
    probe: new WorktreeReflinkCapabilityProbe<RuntimeGitIdentity>({
      identify: () => identifySelectedGit(),
      readHelp: readSelectedGitHelp,
    }),
    run: runSelectedGit,
  });
  return service;
}
