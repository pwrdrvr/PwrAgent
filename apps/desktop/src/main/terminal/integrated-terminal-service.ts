import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { IPty, IDisposable } from "node-pty";
import type {
  DesktopIntegratedTerminalWindowsShell,
  FederationRemoteTarget,
} from "@pwragent/shared";
import {
  INTEGRATED_TERMINAL_ERROR_CHANNEL,
  INTEGRATED_TERMINAL_EXIT_CHANNEL,
  INTEGRATED_TERMINAL_OUTPUT_CHANNEL,
} from "../../shared/ipc";
import type {
  IntegratedTerminalCloseRequest,
  IntegratedTerminalCreateRequest,
  IntegratedTerminalCreateResponse,
  IntegratedTerminalResizeRequest,
  IntegratedTerminalSessionSummary,
  IntegratedTerminalSetPanelHiddenRequest,
  IntegratedTerminalWriteRequest,
} from "../../shared/integrated-terminal";
import { getMainLogger } from "../log";
import {
  clampTerminalColumns,
  clampTerminalRows,
  PtyResizeCoalescer,
} from "./pty-resize";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { resolveBundledClaudeExecutable } from "../claude/claude-bundled-executable";
import { resolveClaudeExecutable } from "../claude/claude-executable";
import { resolvePwragentRoot } from "../profile";
import { terminalHasForegroundCommand } from "./terminal-foreground-command";
import { isWithinWorktree } from "./worktree-terminals";

import { restoredHistoryPrelude, TerminalReplay } from "./terminal-replay";
import { TerminalHistoryStore, type TerminalHistoryRecord } from "./terminal-history-store";

const PTY_SHUTDOWN_FORCE_KILL_MS = 500;
const RUNTIME_PATH_PREFIX_ENV =
  "PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX";
const ORIGINAL_ZDOTDIR_ENV = "PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR";
const ORIGINAL_ZDOTDIR_UNSET_ENV =
  "PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET";
const INTEGRATION_ZDOTDIR_ENV =
  "PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR";

// Every variable this module exports into a terminal. PwrAgent launched from
// a PwrAgent terminal inherits them through `process.env`, so each spawn
// clears them before deciding what this terminal needs. Without that, a stale
// prefix from the previous instance is reapplied to PATH.
const OWNED_TERMINAL_ENV = [
  RUNTIME_PATH_PREFIX_ENV,
  ORIGINAL_ZDOTDIR_ENV,
  ORIGINAL_ZDOTDIR_UNSET_ENV,
  INTEGRATION_ZDOTDIR_ENV,
] as const;

// Supplying PATH to `zsh -l` is insufficient: common `.zprofile` setup such
// as `brew shellenv` prepends another bin directory during startup. ZDOTDIR is
// zsh's supported user-startup-file root, so these wrappers source the user's
// real files in order and reassert the selected runtime path afterward.
const ZSH_INTEGRATION_FILES: Readonly<Record<string, string>> = {
  // Each wrapper hands off to the next startup file zsh will read, and the
  // last one restores. `restoreWhen` names the case where there is no next
  // file: without it a `zsh -c` spawned from a user startup file reads only
  // `.zshenv`, never restores, and leaks ZDOTDIR to all of its descendants.
  ".zshenv": zshStartupFileWrapper(".zshenv", {
    restoreWhen: '[[ ! -o RCS ]] || [[ ! -o LOGIN && ! -o INTERACTIVE ]]',
  }),
  // `.zprofile` runs only for a login shell, which always reaches `.zlogin`.
  ".zprofile": zshStartupFileWrapper(".zprofile", {
    restoreWhen: "[[ ! -o RCS ]]",
  }),
  ".zshrc": zshStartupFileWrapper(".zshrc", {
    prependRuntimePath: true,
    restoreWhen: "[[ ! -o RCS ]] || [[ ! -o LOGIN ]]",
  }),
  ".zlogin": zshStartupFileWrapper(".zlogin", {
    prependRuntimePath: true,
    restoreWhen: "always",
  }),
};

function zshStartupFileWrapper(
  fileName: string,
  options: {
    prependRuntimePath?: boolean;
    restoreWhen: string | "always";
  },
): string {
  // Prepend only when the prefix is not already leading. `.zshrc` and
  // `.zlogin` both run this on a PATH that already starts with the prefix
  // Node put there, and an unconditional prepend duplicates it every time.
  const prependRuntimePath = options.prependRuntimePath
    ? `
if [[ -n "$${RUNTIME_PATH_PREFIX_ENV}" && "$PATH" != "$${RUNTIME_PATH_PREFIX_ENV}" && "$PATH" != "$${RUNTIME_PATH_PREFIX_ENV}:"* ]]; then
  export PATH="$${RUNTIME_PATH_PREFIX_ENV}${"${PATH:+:$PATH}"}"
fi
`
    : "";
  const restoreZdotdir = zshRestoreOriginalZdotdir();
  return `
if [[ "$${ORIGINAL_ZDOTDIR_UNSET_ENV}" == "1" ]]; then
  unset ZDOTDIR
else
  ZDOTDIR="$${ORIGINAL_ZDOTDIR_ENV}"
fi
if [[ "$${ORIGINAL_ZDOTDIR_ENV}" != "$${INTEGRATION_ZDOTDIR_ENV}" && -r "$${ORIGINAL_ZDOTDIR_ENV}/${fileName}" ]]; then
  source "$${ORIGINAL_ZDOTDIR_ENV}/${fileName}"
fi
if (( ${"${+ZDOTDIR}"} )); then
  export ${ORIGINAL_ZDOTDIR_ENV}="$ZDOTDIR"
  unset ${ORIGINAL_ZDOTDIR_UNSET_ENV}
else
  export ${ORIGINAL_ZDOTDIR_ENV}="$HOME"
  export ${ORIGINAL_ZDOTDIR_UNSET_ENV}="1"
fi
ZDOTDIR="$${INTEGRATION_ZDOTDIR_ENV}"
${prependRuntimePath}${options.restoreWhen === "always"
    ? restoreZdotdir
    : `
if ${options.restoreWhen}; then
${restoreZdotdir}
fi
`}
`.trimStart();
}

function zshRestoreOriginalZdotdir(): string {
  return `if [[ "$${ORIGINAL_ZDOTDIR_UNSET_ENV}" == "1" ]]; then
  unset ZDOTDIR
else
  ZDOTDIR="$${ORIGINAL_ZDOTDIR_ENV}"
fi
unset ${OWNED_TERMINAL_ENV.join(" ")}`;
}

let zshIntegrationDirectoryPromise: Promise<string> | undefined;

/**
 * The PowerShell counterpart to the zsh wrappers above. `$PROFILE` is the same
 * hazard as `.zprofile` — conda, scoop and chocolatey initializers all prepend
 * to `$env:Path` — and PwrAgent launches PowerShell with `-NoLogo` only, so
 * profiles run. PowerShell has no ZDOTDIR, but it runs `-Command` *after* the
 * profile, and `-NoExit` keeps the session interactive afterwards, so the
 * reassertion rides on the invocation instead of on a startup file.
 *
 * Two deliberate constraints on the text:
 *
 * - Inline rather than a `.ps1`, because ExecutionPolicy gates script files
 *   and not `-Command`. A `Restricted` machine would otherwise print a load
 *   error into every terminal.
 * - No `"` anywhere, so node-pty's `argsToCommandLine` quoting has nothing to
 *   escape and PowerShell's own `-Command` requoting cannot alter it.
 *
 * The body runs inside `& { … }` so `$p` and `$c` do not leak into the
 * operator's session; `$env:` assignments are process-wide regardless.
 */
const POWERSHELL_RUNTIME_PATH_COMMAND = [
  "& {",
  `$p = $env:${RUNTIME_PATH_PREFIX_ENV};`,
  "if (-not $p) { return };",
  "$c = $env:Path;",
  "if (-not $c) { $env:Path = $p; return };",
  "if ($c -eq $p -or $c.StartsWith($p + ';',"
  + " [StringComparison]::OrdinalIgnoreCase)) { return };",
  "$env:Path = $p + ';' + $c",
  "};",
  `Remove-Item Env:${RUNTIME_PATH_PREFIX_ENV} -ErrorAction SilentlyContinue`,
].join(" ");

/**
 * `-NoExit -Command` is appended only when there is something to pin, so a
 * terminal with no managed runtime keeps the plain invocation it always had.
 * The exact-case lookup is safe because `prependIntegratedTerminalRuntimePaths`
 * removes every other casing before writing this one.
 */
function windowsPowerShellArgs(env: NodeJS.ProcessEnv): string[] {
  return env[RUNTIME_PATH_PREFIX_ENV]
    ? ["-NoLogo", "-NoExit", "-Command", POWERSHELL_RUNTIME_PATH_COMMAND]
    : ["-NoLogo"];
}

type TerminalSession = {
  /** Owns this PTY's size: clamping, deduplication, and pacing. */
  resizes: PtyResizeCoalescer;
  sessionId: string;
  threadKey: string;
  pty: IPty;
  cwd: string;
  shell: string;
  replay: TerminalReplay;
  name?: string;
  closing?: boolean;
  outputPaused?: boolean;
  /** User collapsed the panel; the PTY keeps running. Owned here so the
   *  preference outlives any renderer remount. */
  panelHidden: boolean;
  createdAt: number;
  subscribers: Set<WebContents>;
  disposables: IDisposable[];
};

type NodePtyModule = typeof import("node-pty");

/**
 * node-pty's concrete terminals expose `destroy()` even though its public
 * `IPty` type omits the method. On Unix it closes the PTY master and then
 * sends SIGHUP once the master stream has closed; `kill()` only sends the
 * signal and leaves the master open.
 */
type DestroyablePty = IPty & {
  destroy?: () => void;
};

/**
 * One shell holding up the quit. The owning peer travels with the thread key
 * because a remote shell's thread does not exist in this instance's thread
 * list — resolving its name against that list yields the raw thread id, which
 * is exactly the uuid an operator sees in the quit dialog instead of the name
 * their own sidebar is already showing.
 */
export type IntegratedTerminalQuitThread = {
  /** Which shell. A thread can hold up the quit with more than one. */
  sessionId: string;
  threadKey: string;
  /** Absent for a shell running on this machine. */
  target?: FederationRemoteTarget;
  /** Peer display label, when the federation runtime could compose one. */
  instanceLabel?: string;
};

export type IntegratedTerminalQuitSnapshot = {
  count: number;
  sessionIds: string[];
  threads: IntegratedTerminalQuitThread[];
};

/** `[value]`, or `[]` for a lookup that found nothing. */
function toTargets<T>(value: T | undefined): T[] {
  return value ? [value] : [];
}

/**
 * A thread's terminals, oldest first, from any registry that keys terminals
 * this way. Both this service and the federation bridge group by thread, and
 * the ordering is load-bearing in both: it decides which terminal a create
 * request that names none attaches to. One rule, so the local and remote
 * paths cannot drift on what "the thread's terminal" means.
 */
export function terminalsForThread<
  T extends { threadKey: string; createdAt: number },
>(sessions: Iterable<T>, threadKey: string): T[] {
  return [...sessions]
    .filter((session) => session.threadKey === threadKey)
    .sort((left, right) => left.createdAt - right.createdAt);
}

/**
 * Code-unit order, matching the plain `.sort()` these keys used before they
 * became objects. `localeCompare` would reorder around the `:` and `-` that
 * fill thread keys depending on the host locale, which is not something a
 * quit dialog's row order should depend on.
 *
 * Ties break on the terminal id. Thread keys stopped being unique when a
 * thread gained the ability to own several shells, and a comparator that
 * reports 0 for two distinct rows leaves their order up to whichever sort the
 * host happens to implement.
 */
export function byQuitTerminal(
  left: IntegratedTerminalQuitThread,
  right: IntegratedTerminalQuitThread,
): number {
  if (left.threadKey !== right.threadKey) {
    return left.threadKey < right.threadKey ? -1 : 1;
  }
  if (left.sessionId === right.sessionId) return 0;
  return left.sessionId < right.sessionId ? -1 : 1;
}

type IntegratedTerminalServiceOptions = {
  historyStore?: TerminalHistoryStore;
  loadNodePty?: () => Promise<Pick<NodePtyModule, "spawn">>;
  now?: () => number;
  onSessionsChanged?: (sessions: IntegratedTerminalSessionSummary[]) => void;
  platform?: NodeJS.Platform;
  readLinuxProcessStat?: (pid: number) => string;
};

export class IntegratedTerminalService {
  private readonly logger = getMainLogger("pwragent:integrated-terminal");
  /**
   * The registry, and the only one. There used to be a parallel
   * `sessionsByThread` map, which made the thread key the terminal's identity
   * and capped a thread at one shell as a side effect of how it was stored.
   * Threads group terminals now; they do not name them.
   */
  private readonly sessionsById = new Map<string, TerminalSession>();
  private readonly loadNodePty: () => Promise<Pick<NodePtyModule, "spawn">>;
  private readonly now: () => number;
  private readonly onSessionsChanged?: (
    sessions: IntegratedTerminalSessionSummary[],
  ) => void;
  private readonly platform: NodeJS.Platform;
  private readonly readLinuxProcessStat?: (pid: number) => string;
  /** Terminals mid-spawn, by id, with the thread each belongs to — the window
   *  in which a close has nothing to act on yet. The thread is kept because a
   *  close can still only name one when the pane has yet to learn its id. */
  private readonly spawningThreadKeyBySessionId = new Map<string, string>();
  /** Closes that arrived during that window, to be honored on spawn. */
  private readonly pendingCloseSessionIds = new Set<string>();
  /** One `destroyed` listener per WebContents, not per session — 10 terminals
   *  in one window used to install 10 and trip Node's max-listeners warning. */
  private readonly subscribedWebContents = new Set<WebContents>();
  private readonly archived = new Map<string, TerminalHistoryRecord>();
  private readonly pendingCreates = new Map<string, {
    request: IntegratedTerminalCreateRequest;
    promise: Promise<IntegratedTerminalCreateResponse>;
  }>();
  private readonly removingWorktrees = new Set<string>();
  private readonly historyStore?: TerminalHistoryStore;
  private readonly ready: Promise<void>;
  private disposing = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: IntegratedTerminalServiceOptions = {}) {
    this.historyStore = options.historyStore;
    this.ready = this.historyStore?.load().then((records) => {
      for (const record of records) {
        if (record.peerId) continue;
        record.summary = { ...record.summary, status: "restored", pid: undefined };
        this.archived.set(record.summary.sessionId, record);
      }
      this.emitSessionsChanged();
    }).catch((error) => this.logger.warn("history-load-failed", { error: String(error) })) ?? Promise.resolve();
    this.loadNodePty = options.loadNodePty ?? loadNodePty;
    this.now = options.now ?? Date.now;
    this.onSessionsChanged = options.onSessionsChanged;
    this.platform = options.platform ?? process.platform;
    this.readLinuxProcessStat = options.readLinuxProcessStat;
  }

  async createOrAttach(
    request: IntegratedTerminalCreateRequest,
    webContents: WebContents,
  ): Promise<IntegratedTerminalCreateResponse> {
    if (this.disposing) throw new Error("Terminal service is shutting down.");
    this.assertWorktreeAvailable(request.cwd);
    const key = request.sessionId || `thread:${request.threadKey}`;
    const pending = this.pendingCreates.get(key);
    if (pending) {
      const response = await pending.promise;
      const session = this.sessionsById.get(response.sessionId);
      if (response.threadKey !== request.threadKey.trim()) throw new Error("Terminal thread mismatch.");
      if (!session) return response;
      this.subscribe(session, webContents);
      return this.toCreateResponse(session);
    }
    const creation = this.createSession(request, webContents);
    this.pendingCreates.set(key, { request, promise: creation });
    try { return await creation; }
    finally { this.pendingCreates.delete(key); }
  }

  private async createSession(
    request: IntegratedTerminalCreateRequest,
    webContents: WebContents,
  ): Promise<IntegratedTerminalCreateResponse> {
    await this.ready;
    const threadKey = request.threadKey.trim();
    if (!threadKey) {
      throw new Error("A thread key is required to start a terminal.");
    }

    const requestedId = request.sessionId?.trim();
    const existing = requestedId
      ? this.sessionsById.get(requestedId)
      : this.sessionsForThread(threadKey)[0];
    if (existing) {
      this.assertWorktreeAvailable(existing.cwd);
      if (existing.threadKey !== threadKey) {
        // The id outlived the pane that held it and now names some other
        // thread's shell. Attaching would show one thread's terminal inside
        // another's pane, and every later write would land in the wrong
        // shell.
        throw new Error("That terminal belongs to a different thread.");
      }
      // Deliberately does NOT touch `panelHidden`. The renderer mounts a pane
      // — and therefore attaches — for every live session, including collapsed
      // ones, so an attach is not evidence that the user wants to see it.
      // Un-hiding here made a collapsed terminal pop back open on every
      // remount. Showing a panel is an explicit act: `setPanelHidden(false)`.
      this.subscribe(existing, webContents);
      return this.toCreateResponse(existing);
    }

    const archived = requestedId ? this.archived.get(requestedId) : undefined;
    this.assertWorktreeAvailable(archived?.summary.cwd ?? request.cwd);
    if (archived) {
      if (archived.summary.threadKey !== threadKey) throw new Error("Terminal thread mismatch.");
      if (!request.resume) return { ...archived.summary, snapshot: archived.snapshot };
    } else if (request.attachOnly && !request.resume) throw new Error("This terminal is no longer available. Create a new terminal to start a shell.");
    if (this.sessionsById.size + this.spawningThreadKeyBySessionId.size >= 64
      || this.sessionsForThread(threadKey).length >= 16) throw new Error("Terminal session limit reached.");

    // Settle identity before the spawn, not after it. Everything the spawn
    // window has to coordinate — a close arriving mid-flight, above all — is
    // then addressed by the same id the finished terminal answers to.
    const sessionId = requestedId || randomUUID();
    this.spawningThreadKeyBySessionId.set(sessionId, threadKey);
    let ptyProcess: IPty;
    let cwd: string;
    let shell: { file: string; args: string[] };
    try {
      const spawned = await spawnTerminalPty({
        // A resumed terminal starts where it was launched, not wherever the
        // pane happens to suggest.
        cwd: archived?.summary.cwd ?? request.cwd,
        cols: request.cols,
        rows: request.rows,
        platform: this.platform,
        loadNodePty: this.loadNodePty,
      });
      ptyProcess = spawned.pty;
      cwd = spawned.cwd;
      shell = spawned.shell;
    } catch (error) {
      const message = terminalStartErrorMessage(error);
      this.logger.warn("start-failed", {
        error: error instanceof Error ? error.message : String(error),
        threadKey,
      });
      // The spawn died, so there is nothing left for a queued close to kill.
      // Leaving the id behind would shoot down a later terminal that reuses
      // it.
      this.pendingCloseSessionIds.delete(sessionId);
      throw new Error(message, { cause: error });
    } finally {
      this.spawningThreadKeyBySessionId.delete(sessionId);
    }
    const session: TerminalSession = {
      sessionId,
      threadKey,
      pty: ptyProcess,
      // Seeded with the grid `spawnTerminalPty` just sized this PTY to, from
      // this same request.
      resizes: new PtyResizeCoalescer({
        apply: (cols, rows) => {
          ptyProcess.resize(cols, rows);
          session.replay.resize(cols, rows);
        },
        now: () => this.now(),
        onDeferredError: (error) => {
          this.logger.warn("resize-failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        },
        spawnedCols: request.cols,
        spawnedRows: request.rows,
      }),
      cwd,
      shell: shell.file,
      replay: new TerminalReplay(request.cols, request.rows),
      panelHidden: false,
      createdAt: archived?.summary.createdAt ?? this.now(),
      ...(archived?.summary.name ? { name: archived.summary.name } : {}),
      subscribers: new Set(),
      disposables: [],
    };
    if (archived) {
      // Seeded before the PTY's first byte can arrive, so the history sits
      // above the new prompt in every snapshot from here on. The saved file
      // stays until this live session's next checkpoint overwrites it.
      session.replay.append(restoredHistoryPrelude(archived.snapshot));
      this.archived.delete(sessionId);
    }
    this.sessionsById.set(session.sessionId, session);
    this.subscribe(session, webContents);
    session.disposables.push(
      ptyProcess.onData((data) => this.handleOutput(session, data)),
      ptyProcess.onExit((event) => this.handleExit(session, event.exitCode, event.signal)),
    );
    this.logger.info("started", {
      cwd,
      pid: ptyProcess.pid,
      shell: shell.file,
      threadKey,
    });

    // Spawning is slow (login-shell env capture, then the node-pty load), and a
    // close issued in that window used to find nothing in the registry and
    // silently no-op — leaving a live shell the user had already dismissed,
    // which the renderer then re-adopted from the sessions broadcast. Honor the
    // close now that we finally have something to kill.
    if (this.pendingCloseSessionIds.delete(sessionId)
      || this.pendingCloseSessionIds.delete(`thread:${threadKey}`) || this.disposing) {
      this.logger.info("closing-on-spawn", { sessionId, threadKey });
      this.killSession(session);
      return { sessionId, threadKey, cwd, shell: shell.file, status: "exited" };
    }

    this.emitSessionsChanged();
    return this.toCreateResponse(session);
  }

  /** Every live PTY, oldest first. The renderer's only source of terminal truth. */
  listSessions(): IntegratedTerminalSessionSummary[] {
    return [
      ...[...this.sessionsById.values()].map((session) => this.toSummary(session)),
      ...[...this.archived.values()].map((record) => record.summary),
    ].sort((left, right) => left.createdAt - right.createdAt);
  }

  setPanelHidden(request: IntegratedTerminalSetPanelHiddenRequest): void {
    const session = this.sessionsById.get(request.sessionId);
    if (!session) {
      const record = this.archived.get(request.sessionId);
      if (record) { record.summary.panelHidden = request.hidden; this.emitSessionsChanged(); }
      return;
    }
    if (session.panelHidden === request.hidden) return;
    session.panelHidden = request.hidden;
    if (request.hidden) void this.checkpoint(session);
    this.emitSessionsChanged();
  }

  /**
   * Un-hide one terminal's panel and report the thread it belongs to, which
   * the reveal broadcast carries so a renderer knows which thread's chrome to
   * bring forward.
   *
   * Undefined when there is no such terminal, so callers don't ask the
   * renderer to show a shell that has exited.
   */
  revealSession(sessionId: string): { threadKey: string } | undefined {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return undefined;
    }
    this.setPanelHidden({ sessionId, hidden: false });
    return { threadKey: session.threadKey };
  }

  /** A thread's live terminals, oldest first. */
  private sessionsForThread(threadKey: string): TerminalSession[] {
    return terminalsForThread(this.sessionsById.values(), threadKey);
  }

  write(request: IntegratedTerminalWriteRequest): void {
    this.sessionsById.get(request.sessionId)?.pty.write(request.data);
  }

  resize(request: IntegratedTerminalResizeRequest): void {
    // Viewers share this PTY, so clamping, deduplication, and pacing all
    // happen at its owner rather than against a renderer's stale last size.
    this.sessionsById
      .get(request.sessionId)
      ?.resizes.request(request.cols, request.rows);
  }

  rename(sessionId: string, name: string): void {
    const clean = name.trim().replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80);
    const session = this.sessionsById.get(sessionId);
    if (session) { session.name = clean; void this.checkpoint(session); }
    const record = this.archived.get(sessionId);
    if (record) { record.summary.name = clean; void this.historyStore?.save(record).catch(() => undefined); }
    this.emitSessionsChanged();
  }

  /** Thread-bound owner API for the read-only tool stack. */
  outputForThread(threadKey: string, sessionId: string): TerminalReplay | undefined {
    const session = this.sessionsById.get(sessionId);
    return session?.threadKey === threadKey ? session.replay : undefined;
  }

  async snapshotForThread(threadKey: string, sessionId: string) {
    await this.ready;
    const live = this.sessionsById.get(sessionId);
    if (live?.threadKey === threadKey) return live.replay.snapshot();
    const record = this.archived.get(sessionId);
    return record?.summary.threadKey === threadKey ? { ...record.snapshot } : undefined;
  }

  close(request: IntegratedTerminalCloseRequest): void {
    const pendingKey = request.sessionId || `thread:${request.threadKey}`;
    if (this.pendingCreates.has(pendingKey)) this.pendingCloseSessionIds.add(pendingKey);
    let removedHistory = false;
    for (const [id, record] of this.archived) {
      if (request.sessionId ? id === request.sessionId : record.summary.threadKey === request.threadKey) {
        this.archived.delete(id);
        removedHistory = true;
        void this.historyStore?.remove(id).catch(() => undefined);
      }
    }
    if (removedHistory) this.emitSessionsChanged();
    // An explicit id NEVER widens to the thread. A request naming a terminal
    // that has already exited means "that one is gone", not "take the rest of
    // the thread with it" — and since a thread can now own several, falling
    // through would kill shells the caller never named.
    const targets = request.sessionId
      ? toTargets(this.sessionsById.get(request.sessionId))
      : request.threadKey
        ? this.sessionsForThread(request.threadKey)
        : [];
    for (const session of targets) {
      this.pendingCloseSessionIds.delete(session.sessionId);
      this.killSession(session);
    }
    if (targets.length > 0) {
      return;
    }
    // Nothing to kill yet. If a spawn this close names is still in flight,
    // mark it so `createOrAttach` kills the session the moment it exists —
    // otherwise the close is lost and the shell survives the user dismissing
    // it. Gated on an in-flight spawn so a close for an idle thread can't
    // linger and shoot down some unrelated terminal the user opens later.
    for (const [sessionId, threadKey] of this.spawningThreadKeyBySessionId) {
      const named = request.sessionId
        ? sessionId === request.sessionId
        : threadKey === request.threadKey;
      if (named) {
        this.pendingCloseSessionIds.add(sessionId);
      }
    }
  }

  private isInWorktree(cwd: string | undefined, worktreePath: string): boolean {
    return isWithinWorktree(cwd, worktreePath, this.platform);
  }

  private assertWorktreeAvailable(cwd: string | undefined): void {
    if ([...this.removingWorktrees].some((worktree) => this.isInWorktree(cwd, worktree))) {
      throw new Error("This worktree is being removed; a terminal cannot be opened here.");
    }
  }

  async withWorktreeClosed<T>(worktreePath: string, work: () => Promise<T>, assertCurrent?: () => void): Promise<T> {
    assertCurrent?.();
    this.assertWorktreeAvailable(worktreePath);
    this.removingWorktrees.add(worktreePath);
    try {
      // Creations already past admission must finish registering their PTYs
      // before we collect them. New creations under this checkout are blocked
      // until the destructive operation has settled, including on failure.
      await this.ready;
      await Promise.allSettled([...this.pendingCreates.values()]
        .filter(({ request }) => this.isInWorktree(
          (request.sessionId ? this.archived.get(request.sessionId)?.summary.cwd : undefined) ?? request.cwd,
          worktreePath,
        ))
        .map(({ promise }) => promise));
      assertCurrent?.();
      await Promise.all([...this.sessionsById.values()]
        .filter((session) => this.isInWorktree(session.cwd, worktreePath))
        .map(async (session) => {
          assertCurrent?.();
          session.closing = true;
          await this.disposeSessionForShutdown(session);
          await this.historyStore?.remove(session.sessionId);
        }));
      return await work();
    } finally {
      this.removingWorktrees.delete(worktreePath);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposing = true;
    this.disposePromise = Promise.all([
      ...[...this.pendingCreates.values()].map(({ promise }) => promise),
      ...Array.from(this.sessionsById.values()).map((session) => Promise.all([
        this.checkpoint(session),
        this.disposeSessionForShutdown(session),
      ])),
    ]).then(() => undefined);
    this.subscribedWebContents.clear();
    return this.disposePromise;
  }

  getQuitSnapshot(): IntegratedTerminalQuitSnapshot {
    const sessions = [...this.sessionsById.values()].filter((session) =>
      this.hasForegroundCommand(session),
    );
    return {
      count: sessions.length,
      sessionIds: sessions.map((session) => session.sessionId).sort(),
      threads: sessions
        .map((session) => ({
          sessionId: session.sessionId,
          threadKey: session.threadKey,
        }))
        .sort(byQuitTerminal),
    };
  }

  private hasForegroundCommand(session: TerminalSession): boolean {
    return terminalHasForegroundCommand(
      {
        processName: () => session.pty.process,
        pid: session.pty.pid,
        shell: session.shell,
      },
      {
        platform: this.platform,
        ...(this.readLinuxProcessStat
          ? { readLinuxProcessStat: this.readLinuxProcessStat }
          : {}),
        onError: (error) => {
          this.logger.warn("foreground-process-check-failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId: session.sessionId,
          });
        },
      },
    );
  }

  private async toCreateResponse(
    session: TerminalSession,
  ): Promise<IntegratedTerminalCreateResponse> {
    const snapshot = await session.replay.snapshot();
    return {
      sessionId: session.sessionId,
      threadKey: session.threadKey,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pty.pid,
      snapshot,
      status: "running",
    };
  }

  private toSummary(session: TerminalSession): IntegratedTerminalSessionSummary {
    return {
      sessionId: session.sessionId,
      threadKey: session.threadKey,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pty.pid,
      panelHidden: session.panelHidden,
      createdAt: session.createdAt,
      name: session.name,
      status: "running",
    };
  }

  private emitSessionsChanged(): void {
    if (this.disposing) return;
    this.onSessionsChanged?.(this.listSessions());
  }

  private subscribe(session: TerminalSession, webContents: WebContents): void {
    if (webContents.isDestroyed()) {
      return;
    }
    if (session.subscribers.has(webContents)) {
      return;
    }
    session.subscribers.add(webContents);

    // One listener per WebContents, cleaning up across ALL sessions. Attaching
    // one per session put 10+ `destroyed` listeners on a single window (that is
    // exactly the load this feature is built for) and tripped Node's
    // max-listeners warning.
    if (!this.subscribedWebContents.has(webContents)) {
      this.subscribedWebContents.add(webContents);
      webContents.once("destroyed", () => {
        this.subscribedWebContents.delete(webContents);
        for (const candidate of this.sessionsById.values()) {
          candidate.subscribers.delete(webContents);
        }
      });
    }
  }

  private handleOutput(session: TerminalSession, data: string): void {
    if (this.disposing || this.sessionsById.get(session.sessionId) !== session) {
      return;
    }
    const frame = session.replay.append(data, this.now());
    if (!session.outputPaused && session.replay.pendingCharacters >= 256 * 1024) {
      session.outputPaused = true;
      session.pty.pause();
      void session.replay.whenDrained().then(() => {
        session.outputPaused = false;
        if (this.sessionsById.get(session.sessionId) === session && !this.disposing) session.pty.resume();
      });
    }
    this.send(session, INTEGRATED_TERMINAL_OUTPUT_CHANNEL, {
      sessionId: session.sessionId,
      data,
      seq: frame.seq,
      timestamp: frame.timestamp,
    });
  }

  private handleExit(
    session: TerminalSession,
    exitCode: number | undefined,
    signal: number | undefined,
  ): void {
    if (this.disposing || this.sessionsById.get(session.sessionId) !== session) {
      return;
    }
    this.send(session, INTEGRATED_TERMINAL_EXIT_CHANNEL, {
      sessionId: session.sessionId,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
    });
    if (session.closing) {
      this.deleteSession(session);
      void this.historyStore?.remove(session.sessionId).catch(() => undefined);
    } else {
      // Preserve the screen after natural exit; never silently start a shell.
      // Announce the removal only once the exited record is archived, so the
      // tab never drops out of the list in between: that unmounted its pane
      // and, for a thread's only terminal, closed the panel for a moment.
      const archiving = this.checkpoint(session, exitCode ?? null);
      this.deleteSession(session, false);
      void archiving.finally(() => this.emitSessionsChanged());
    }
  }

  private async checkpoint(session: TerminalSession, exitCode?: number | null): Promise<void> {
    try {
      const record: TerminalHistoryRecord = {
        version: 1,
        summary: { ...this.toSummary(session), status: exitCode === undefined ? "restored" : "exited", pid: undefined, exitCode },
        snapshot: { ...await session.replay.snapshot(), pendingEscape: undefined },
        savedAt: this.now(),
      };
      if (session.closing) return;
      // Restarted under the same id before this snapshot settled: the live
      // shell owns the id and its own checkpoints now.
      const current = this.sessionsById.get(session.sessionId);
      if (current && current !== session) return;
      if (exitCode !== undefined) {
        this.archived.set(session.sessionId, record);
        while (this.archived.size > 64) this.archived.delete(this.archived.keys().next().value!);
      }
      await this.historyStore?.save(record);
    } catch (error) { this.logger.warn("history-save-failed", { error: String(error) }); }
  }

  private killSession(session: TerminalSession): void {
    session.closing = true;
    void this.historyStore?.remove(session.sessionId).catch(() => undefined);
    try {
      session.pty.kill();
    } catch (error) {
      this.logger.warn("kill-failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      this.send(session, INTEGRATED_TERMINAL_ERROR_CHANNEL, {
        sessionId: session.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.deleteSession(session);
    }
  }

  private deleteSession(session: TerminalSession, announce = true): Promise<void> {
    // Before the listeners: a queued resize must not reach a dead PTY.
    session.resizes.dispose();
    this.disposeSessionListeners(session);
    this.sessionsById.delete(session.sessionId);
    session.subscribers.clear();
    const disposed = session.replay.dispose();
    if (announce) this.emitSessionsChanged();
    return disposed;
  }

  private async disposeSessionForShutdown(
    session: TerminalSession,
  ): Promise<void> {
    // Keep a dedicated exit subscription outside `session.disposables`: the
    // renderer-facing listeners must be removed before teardown, but shutdown
    // itself cannot complete until node-pty reports that waitpid finished and
    // its master stream closed.
    let exitDisposable: IDisposable | undefined;
    const exited = new Promise<void>((resolve) => {
      exitDisposable = session.pty.onExit(() => resolve());
    });
    const replayDisposed = this.deleteSession(session);
    try {
      const destroy = (session.pty as DestroyablePty).destroy;
      if (destroy) {
        destroy.call(session.pty);
      } else {
        // Preserve compatibility with test doubles or a future node-pty
        // implementation that removes the concrete destroy method.
        session.pty.kill();
      }
    } catch (error) {
      this.logger.warn("shutdown-kill-failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      exitDisposable?.dispose();
      throw error;
    }
    let forceKillTimer: NodeJS.Timeout | undefined;
    if (this.platform !== "win32") {
      forceKillTimer = setTimeout(() => {
        this.logger.warn("shutdown-force-kill", {
          graceMs: PTY_SHUTDOWN_FORCE_KILL_MS,
          sessionId: session.sessionId,
        });
        try {
          session.pty.kill("SIGKILL");
        } catch (error) {
          this.logger.warn("shutdown-force-kill-failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId: session.sessionId,
          });
        }
      }, PTY_SHUTDOWN_FORCE_KILL_MS);
    }
    try {
      await exited;
      await replayDisposed;
    } finally {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      exitDisposable?.dispose();
    }
  }

  private disposeSessionListeners(session: TerminalSession): void {
    for (const disposable of session.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch (error) {
        this.logger.warn("listener-dispose-failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: session.sessionId,
        });
      }
    }
  }

  private send(session: TerminalSession, channel: string, payload: unknown): void {
    for (const webContents of Array.from(session.subscribers)) {
      if (webContents.isDestroyed()) {
        session.subscribers.delete(webContents);
        continue;
      }
      webContents.send(channel, payload);
    }
  }
}

async function loadNodePty(): Promise<Pick<NodePtyModule, "spawn">> {
  return await import("node-pty");
}

export type SpawnedTerminalPty = {
  pty: IPty;
  cwd: string;
  shell: { file: string; args: string[] };
};

/**
 * The one PTY spawn core: settings-derived login environment, cwd validation
 * with a home-directory fallback, per-platform shell resolution, and clamped
 * dimensions. Shared by the local integrated-terminal service and the
 * federation remote-PTY service so a remote viewer's shell is spawned with
 * exactly the hardening and environment the local panel gets.
 */
export async function spawnTerminalPty(params: {
  cwd?: string;
  cols: number;
  rows: number;
  platform?: NodeJS.Platform;
  loadNodePty?: () => Promise<Pick<NodePtyModule, "spawn">>;
}): Promise<SpawnedTerminalPty> {
  const platform = params.platform ?? process.platform;
  const settings = getDesktopSettingsService();
  const baseEnv = await settings.resolveTerminalSpawnEnvAsync();
  const bundledClaude = await resolveTerminalBundledClaudeCommand(
    baseEnv,
    platform,
  );
  const runtimeCommands = [
    ...settings.resolveIntegratedTerminalCommands(),
    ...(bundledClaude ? [bundledClaude] : []),
  ];
  let env = prependIntegratedTerminalRuntimePaths(
    baseEnv,
    runtimeCommands,
    platform,
  );
  const cwd = resolveTerminalCwd(params.cwd);
  const shell = resolveTerminalShell({
    env,
    platform,
    windowsShell: settings.resolveIntegratedTerminalWindowsShell(),
  });
  env = await prepareIntegratedTerminalShellEnvironment({
    env,
    platform,
    shell: shell.file,
  });
  const nodePty = await (params.loadNodePty ?? loadNodePty)();
  const pty = nodePty.spawn(shell.file, shell.args, {
    name: "xterm-256color",
    cols: clampTerminalColumns(params.cols),
    rows: clampTerminalRows(params.rows),
    cwd,
    env: buildPwrAgentChildProcessEnv(env, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }),
  });
  return { pty, cwd, shell };
}

/**
 * PwrAgent's bundled Claude Code CLI, for a terminal that has no `claude` of
 * its own. A Claude Code the operator installed always wins, so the bundled
 * copy is offered only when the same search the Claude backend runs finds none.
 */
async function resolveTerminalBundledClaudeCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (await resolveClaudeExecutable({ env, platform })) return undefined;
  return await resolveBundledClaudeExecutable({ platform });
}

export function prependIntegratedTerminalRuntimePaths(
  baseEnv: NodeJS.ProcessEnv,
  commands: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = buildPwrAgentChildProcessEnv(baseEnv);
  // Same rule `mergePwrAgentChildProcessEnv` applies to ELECTRON_RENDERER_URL:
  // Windows environment names are case-insensitive, and this is a plain object
  // that is not, so every casing has to go.
  const owned = new Set<string>(OWNED_TERMINAL_ENV);
  for (const key of Object.keys(env)) {
    if (owned.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const runtimeDirectories = commands
    .map((command) => command.trim())
    .filter((command) => pathApi.isAbsolute(command))
    .map((command) => pathApi.dirname(command));
  if (runtimeDirectories.length === 0) return env;

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH")
    ?? "PATH";
  const existingEntries = (env[pathKey] ?? "")
    .split(pathApi.delimiter)
    .filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  const normalizedKey = (entry: string): string => {
    const normalized = pathApi.normalize(entry);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const runtimeSeen = new Set<string>();
  const runtimeEntries = runtimeDirectories.filter((entry) => {
    const key = normalizedKey(entry);
    if (runtimeSeen.has(key)) return false;
    runtimeSeen.add(key);
    return true;
  });
  const entries = [...runtimeEntries, ...existingEntries].filter((entry) => {
    const key = normalizedKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  env[pathKey] = entries.join(pathApi.delimiter);
  // Read by the zsh startup wrappers on POSIX and by the PowerShell command
  // `resolveWindowsTerminalShell` appends on Windows. Both consume it and
  // remove it, so it does not survive into the operator's session.
  env[RUNTIME_PATH_PREFIX_ENV] = runtimeEntries.join(pathApi.delimiter);
  return env;
}

/**
 * Mutates and returns `options.env`. Pass the object
 * `prependIntegratedTerminalRuntimePaths` returned, which is already a private
 * copy — copying it a second time would rebuild the whole environment on a
 * path that runs for every terminal.
 */
export async function prepareIntegratedTerminalShellEnvironment(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  shell: string;
  resolveZshIntegrationDirectory?: () => Promise<string>;
}): Promise<NodeJS.ProcessEnv> {
  const env = options.env;
  if (
    options.platform === "win32"
    || path.basename(options.shell) !== "zsh"
    || !env[RUNTIME_PATH_PREFIX_ENV]
  ) {
    return env;
  }
  try {
    const integrationZdotdir = await (
      options.resolveZshIntegrationDirectory
      ?? ensureZshIntegrationDirectory
    )();
    // Written only once the directory exists: a failure must not leave the
    // shell describing an integration that was never wired.
    const originalZdotdir = env.ZDOTDIR?.trim();
    env[ORIGINAL_ZDOTDIR_ENV] = originalZdotdir || env.HOME || homedir();
    if (!originalZdotdir) {
      env[ORIGINAL_ZDOTDIR_UNSET_ENV] = "1";
    }
    env[INTEGRATION_ZDOTDIR_ENV] = integrationZdotdir;
    env.ZDOTDIR = integrationZdotdir;
  } catch (error) {
    getMainLogger("pwragent:integrated-terminal").warn(
      "zsh-runtime-path-integration-failed",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
  return env;
}

async function ensureZshIntegrationDirectory(): Promise<string> {
  // Caching a rejection would turn one transient write failure into a
  // permanently disabled integration for the life of the process.
  zshIntegrationDirectoryPromise ??= writeZshIntegrationDirectory().catch(
    (error: unknown) => {
      zshIntegrationDirectoryPromise = undefined;
      throw error;
    },
  );
  return await zshIntegrationDirectoryPromise;
}

export async function writeZshIntegrationDirectory(
  directory = path.join(
    resolvePwragentRoot(),
    "shell-integration",
    "zsh-v2",
  ),
): Promise<string> {
  await mkdir(directory, { recursive: true });
  // A crash between `writeFile` and `rename`, or a sibling write rejecting
  // first and abandoning the others, leaves a staged file in the directory
  // PwrAgent hands zsh as ZDOTDIR. Nothing else ever removes one.
  await removeOrphanedIntegrationTempFiles(directory);
  await Promise.all(
    Object.entries(ZSH_INTEGRATION_FILES).map(async ([name, contents]) => {
      const destination = path.join(directory, name);
      const temporary = path.join(
        directory,
        `.${name}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }),
  );
  return directory;
}

async function removeOrphanedIntegrationTempFiles(
  directory: string,
): Promise<void> {
  try {
    const entries = await readdir(directory);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(".") && entry.endsWith(".tmp"))
        .map(async (entry) => {
          await unlink(path.join(directory, entry)).catch(() => undefined);
        }),
    );
  } catch {
    // A directory we cannot list is not a reason to skip writing the wrappers.
  }
}

function terminalStartErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail
    ? `Terminal failed to start: ${detail}`
    : "Terminal failed to start.";
}

function resolveTerminalCwd(requestedCwd: string | undefined): string {
  const candidate = requestedCwd?.trim();
  if (candidate) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Fall through to the user home directory.
    }
  }
  return homedir();
}

export function resolveTerminalShell(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  windowsShell?: DesktopIntegratedTerminalWindowsShell;
}): {
  file: string;
  args: string[];
} {
  if (options.platform === "win32") {
    return resolveWindowsTerminalShell(
      options.env,
      options.windowsShell ?? "auto",
    );
  }
  return {
    file: resolvePosixTerminalShell(options.env, options.platform),
    args: ["-l"],
  };
}

function resolvePosixTerminalShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const configuredShell = env.SHELL?.trim();
  if (configuredShell) {
    return configuredShell;
  }

  const candidates =
    platform === "darwin"
      ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
      : ["/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep scanning fallback shells.
    }
  }
  return "/bin/sh";
}

function resolveWindowsTerminalShell(
  env: NodeJS.ProcessEnv,
  preference: DesktopIntegratedTerminalWindowsShell,
): {
  file: string;
  args: string[];
} {
  if (preference === "pwsh") {
    return { file: "pwsh.exe", args: windowsPowerShellArgs(env) };
  }
  if (preference === "powershell") {
    return { file: "powershell.exe", args: windowsPowerShellArgs(env) };
  }
  // cmd.exe reasserts nothing: its only startup hook is the AutoRun registry
  // value, and batch has no cheap way to ask whether PATH already leads with
  // the prefix. An AutoRun that rewrites PATH still wins here.
  if (preference === "cmd") {
    return { file: env.ComSpec || "cmd.exe", args: [] };
  }

  // Discovery searches the operator's PATH, not the pinned one. The runtime
  // directories lead PATH by the time this runs, so scanning them would let a
  // `pwsh.exe` inside a Codex or Grok release bundle become the shell PwrAgent
  // launches. The pin is for the operator's commands, not for choosing a shell.
  const discoveryEnv = withoutRuntimePathPrefix(env);
  if (commandExistsOnPath("pwsh.exe", discoveryEnv, "win32")) {
    return { file: "pwsh.exe", args: windowsPowerShellArgs(env) };
  }
  if (commandExistsOnPath("powershell.exe", discoveryEnv, "win32")) {
    return { file: "powershell.exe", args: windowsPowerShellArgs(env) };
  }
  return { file: env.ComSpec || "cmd.exe", args: [] };
}

/**
 * The environment with the pinned runtime directories removed from PATH, for
 * decisions that must reflect what the operator had rather than what PwrAgent
 * prepended.
 */
function withoutRuntimePathPrefix(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const prefix = env[RUNTIME_PATH_PREFIX_ENV];
  if (!prefix) return env;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  if (!pathKey) return env;
  const pinned = new Set(
    prefix.split(";").map((entry) => path.win32.normalize(entry).toLowerCase()),
  );
  return {
    ...env,
    [pathKey]: (env[pathKey] ?? "")
      .split(";")
      .filter((entry) => {
        if (entry.length === 0) return false;
        return !pinned.has(path.win32.normalize(entry).toLowerCase());
      })
      .join(";"),
  };
}

function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const pathValue = env.PATH || env.Path || env.path;
  if (!pathValue) return false;
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.trim();
    if (!directory) continue;
    try {
      const candidate = path.join(directory, command);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      // Keep scanning PATH entries.
    }
  }
  return false;
}
