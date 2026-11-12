import fs from "node:fs";
import path from "node:path";

/**
 * Codex sandbox policy for the contained Outpost.
 *
 * Codex runs model commands as the same Unix user as the Outpost, so file
 * modes cannot keep an agent out of the Outpost's own state. The profile
 * directory holds the local control socket (`state/headless/rpc.sock`), the
 * file-key secret (`state/headless-secret.key`), the state database and the
 * federation identity it encrypts. Codex's legacy `sandboxPolicy` grants read
 * access to the whole filesystem, so a read-only or workspace-write command
 * could read that key and decrypt every stored secret. The same commands
 * could read the Codex home's credentials, configuration and transcripts.
 *
 * Named Codex permission profiles can deny a path. Every profile this module
 * generates denies the protected roots, and the message rewriter converts
 * every outbound sandbox selection to one of these profiles, so no legacy
 * policy reaches Codex from an Outpost. A workspace root inside a protected
 * root would be more specific than the deny and reopen it, so the rewriter
 * also refuses such a working directory.
 *
 * This module has no PwrAgent imports: the Outpost daemon loads its bundle
 * (`dist/outpost-codex-sandbox.js`) for the sandbox preflight before the
 * owner starts.
 */

export type OutpostSandboxMode = "read-only" | "workspace-write";

export const OUTPOST_PERMISSION_PROFILE_IDS: Readonly<Record<OutpostSandboxMode, string>> = {
  "read-only": "pwragent-outpost-read-only",
  "workspace-write": "pwragent-outpost-workspace-write",
};

const OUTPOST_PROFILE_ID_SET = new Set(Object.values(OUTPOST_PERMISSION_PROFILE_IDS));

/**
 * Config keys an Outpost owns. An operator override or a thread `config`
 * that sets one could redefine an Outpost profile without its deny entries,
 * or reinstate a legacy sandbox.
 */
export const OUTPOST_MANAGED_CONFIG_KEYS = [
  "permissions",
  "default_permissions",
  "sandbox_mode",
  "sandbox_workspace_write",
] as const;

// Requests whose sandbox Codex otherwise takes from the thread, the rollout
// or a legacy config value. Each one must name an Outpost profile.
const PROFILE_REQUIRED_METHODS = new Set(["thread/start", "thread/resume", "thread/fork", "command/exec"]);

/**
 * The canonical path the sandbox and the working-directory guard compare:
 * the real path of the nearest existing ancestor, with letter case as the
 * filesystem stores it (macOS volumes are case-insensitive), plus any
 * missing tail. Windows never hosts an Outpost and keeps the POSIX path.
 */
export function canonicalOutpostPath(value: string): string {
  let existing = path.resolve(value);
  const missing: string[] = [];
  if (process.platform === "win32") return existing;
  for (;;) {
    try { return path.join(fs.realpathSync.native(existing), ...missing.reverse()); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || existing === path.parse(existing).root) throw error;
      missing.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

/**
 * The Codex home entries that hold credentials: the login (`auth.json`, the
 * Codex credential or the model key proxy's), the MCP OAuth fallback store
 * (`.credentials.json`), and Codex's encrypted secret files (`secrets/`).
 * Names only: PwrAgent never opens these files.
 */
export const OUTPOST_CODEX_CREDENTIAL_ENTRIES = ["auth.json", ".credentials.json", "secrets"] as const;

/**
 * Codex home entries only Codex itself reads: its configuration, which can
 * carry MCP headers and tokens (`config.toml`), every thread's transcript
 * (`sessions/`, `archived_sessions/`), the prompt history and session index,
 * and its logs (`log/`).
 */
export const OUTPOST_CODEX_PRIVATE_ENTRIES = ["config.toml", "sessions", "archived_sessions", "history.jsonl", "session_index.jsonl", "log"] as const;

/**
 * Patterns for Codex home files whose names change between Codex releases:
 * its SQLite state and logs (`state_5.sqlite`, `logs_2.sqlite-wal`). Codex
 * expands a glob when each command starts, so a file a newer release adds is
 * denied too. Expansion stops at the Codex home's own files (see
 * OUTPOST_GLOB_SCAN_MAX_DEPTH).
 */
export const OUTPOST_CODEX_PRIVATE_GLOBS = ["*.sqlite*"] as const;

/**
 * How deep Codex expands a deny glob on Linux. ripgrep matches a glob without
 * a slash at any depth, so without a cap `*.sqlite*` also matches files in
 * skills and plugins, and a match inside a directory the profile already
 * masks makes bubblewrap abort every command.
 */
export const OUTPOST_GLOB_SCAN_MAX_DEPTH = 1;

// Characters a Codex filesystem glob reads as syntax.
const GLOB_SYNTAX = /[*?[\]{}\\]/;

/**
 * The paths agent commands must not read. Every PwrAgent profile lives under
 * `<root>/profiles`; the root itself also holds worktrees, so it stays
 * readable. With a Codex home, its credential and private entries are denied
 * as well. The rest of the Codex home stays readable, because the model reads
 * skills, plugin skills, memories and generated images there by path, and
 * every command sources its shell snapshot and runs `apply_patch` from it.
 * Codex 0.159.2 and 0.164.0 kept all of those working with these entries
 * denied, in a disposable Outpost container.
 *
 * Only canonical paths are denied: the sandbox masks the real location, and
 * bubblewrap aborts every command when a deny entry names a symlink. An entry
 * that is a symlink is therefore denied at its target, and one that does not
 * exist yet is denied at its own path, so Codex can still create it and a
 * later command still cannot read it.
 */
export function resolveOutpostProtectedRoots(pwragentRoot: string, codexHome?: string): string[] {
  if (!path.isAbsolute(pwragentRoot)) throw new Error("The Outpost requires an absolute PWRAGENT_HOME.");
  const roots = [canonicalOutpostPath(path.join(pwragentRoot, "profiles"))];
  if (codexHome !== undefined) {
    const home = resolveOutpostCodexHome(codexHome);
    for (const entry of [...OUTPOST_CODEX_CREDENTIAL_ENTRIES, ...OUTPOST_CODEX_PRIVATE_ENTRIES]) {
      const denied = canonicalOutpostPath(path.join(home, entry));
      if (!roots.includes(denied)) roots.push(denied);
    }
    roots.push(...OUTPOST_CODEX_PRIVATE_GLOBS.map((pattern) => path.join(home, pattern)));
  }
  return roots;
}

/**
 * The canonical Codex home. Every Outpost profile makes it read-only, and the
 * message rewriter refuses a working directory inside it: a workspace root
 * there would be more specific than that entry, and a writable Codex home
 * lets a command plant skills, hooks or instructions that Codex later runs
 * outside the sandbox. Its path becomes the stem of glob deny entries, so it
 * must contain no glob syntax.
 */
export function resolveOutpostCodexHome(codexHome: string): string {
  if (!path.isAbsolute(codexHome)) throw new Error("The Outpost requires an absolute Codex home.");
  const home = canonicalOutpostPath(codexHome);
  if (GLOB_SYNTAX.test(home)) throw new Error("The Outpost's Codex home path must not contain *, ?, [, ], {, } or \\.");
  return home;
}

export interface OutpostCodexSandboxOptions {
  /**
   * Paths agent commands may read but never write, even below a writable
   * workspace root. The rewriter refuses a working directory inside one.
   */
  readOnlyRoots?: readonly string[];
}

function assertSandboxPaths(protectedRoots: readonly string[], readOnlyRoots: readonly string[]): void {
  if (protectedRoots.length === 0) throw new Error("The Outpost sandbox requires at least one protected root.");
  for (const root of [...protectedRoots, ...readOnlyRoots]) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root) {
      throw new Error("Outpost protected paths must be normalized absolute paths below the filesystem root.");
    }
  }
}

/**
 * Codex `-c` values (without the flag) defining both Outpost profiles and
 * selecting the read-only one by default. JSON strings are valid TOML basic
 * strings, so paths need no further escaping.
 */
export function buildOutpostCodexPermissionOverrides(
  protectedRoots: readonly string[],
  options: OutpostCodexSandboxOptions = {},
): string[] {
  const readOnlyRoots = options.readOnlyRoots ?? [];
  assertSandboxPaths(protectedRoots, readOnlyRoots);
  const denied = protectedRoots.map((root) => `${JSON.stringify(root)}="deny"`);
  const readOnly = readOnlyRoots.map((root) => `${JSON.stringify(root)}="read"`);
  const filesystem = (mode: OutpostSandboxMode) => `{${[
    ...(protectedRoots.some((root) => root.includes("*")) ? [`glob_scan_max_depth=${OUTPOST_GLOB_SCAN_MAX_DEPTH}`] : []),
    "\":root\"=\"read\"",
    ...(mode === "workspace-write" ? ["\":workspace_roots\"={\".\"=\"write\"}"] : []),
    ...readOnly,
    ...denied,
  ].join(",")}}`;
  return [
    ...(Object.entries(OUTPOST_PERMISSION_PROFILE_IDS) as Array<[OutpostSandboxMode, string]>).flatMap(([mode, id]) => [
      `permissions.${id}.filesystem=${filesystem(mode)}`,
      `permissions.${id}.network.enabled=false`,
    ]),
    `default_permissions=${JSON.stringify(OUTPOST_PERMISSION_PROFILE_IDS["read-only"])}`,
  ];
}

export function isOutpostManagedConfigKey(key: string): boolean {
  return OUTPOST_MANAGED_CONFIG_KEYS.some((managed) =>
    key === managed || key.startsWith(`${managed}.`) || managed.startsWith(`${key}.`));
}

function sandboxModeFrom(value: unknown, field: string): OutpostSandboxMode {
  if (value === "read-only" || value === "workspace-write") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    if (type === "readOnly") return "read-only";
    if (type === "workspaceWrite") return "workspace-write";
  }
  throw new Error(`This Outpost refuses ${field} other than read-only or workspace-write.`);
}

function narrower(left: OutpostSandboxMode | undefined, right: OutpostSandboxMode): OutpostSandboxMode {
  return left === "read-only" || right === "read-only" ? "read-only" : "workspace-write";
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// Codex grants write to each workspace root; one inside a protected or
// read-only root is more specific than that root's entry.
function assertWorkspaceOutsideRefusedRoots(params: Record<string, unknown>, refusedRoots: readonly string[]): void {
  const roots = [params.cwd, ...(Array.isArray(params.runtimeWorkspaceRoots) ? params.runtimeWorkspaceRoots : [])];
  for (const root of roots) {
    if (typeof root !== "string" || !root.trim()) continue;
    const candidate = canonicalOutpostPath(root.trim());
    if (refusedRoots.some((refusedRoot) => isWithin(candidate, refusedRoot))) {
      throw new Error("This Outpost refuses a working directory inside its own state or Codex home.");
    }
  }
}

/**
 * Returns the outbound JSON-RPC rewriter for an Outpost Codex client. It
 * makes every sandbox selection an Outpost permission profile. It throws,
 * failing the request, when the message selects any other profile or
 * sandbox, carries thread config that could redefine one, or names a working
 * directory inside a protected or read-only root. Messages without a method
 * (responses) pass through.
 */
export function createOutpostCodexMessageRewriter(
  protectedRoots: readonly string[],
  options: OutpostCodexSandboxOptions = {},
): (raw: string) => string {
  const readOnlyRoots = options.readOnlyRoots ?? [];
  assertSandboxPaths(protectedRoots, readOnlyRoots);
  const refusedRoots = [...protectedRoots, ...readOnlyRoots];
  return (raw) => rewriteOutpostCodexMessage(raw, refusedRoots);
}

function rewriteOutpostCodexMessage(raw: string, refusedRoots: readonly string[]): string {
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { return raw; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return raw;
  const message = envelope as { method?: unknown; params?: unknown };
  if (typeof message.method !== "string") return raw;
  const method = message.method;
  if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) {
    if (!PROFILE_REQUIRED_METHODS.has(method)) return raw;
    message.params = {};
  }
  const params = message.params as Record<string, unknown>;
  const profileField = method === "command/exec" ? "permissionProfile" : "permissions";
  let changed = false;
  let mode: OutpostSandboxMode | undefined;
  for (const field of ["sandbox", "sandboxPolicy"] as const) {
    if (!Object.hasOwn(params, field)) continue;
    if (params[field] !== null && params[field] !== undefined) mode = narrower(mode, sandboxModeFrom(params[field], field));
    delete params[field];
    changed = true;
  }
  for (const field of ["permissions", "permissionProfile"] as const) {
    const value = params[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !OUTPOST_PROFILE_ID_SET.has(value)) {
      throw new Error("This Outpost refuses Codex permission profiles it did not define.");
    }
    mode = narrower(mode, value === OUTPOST_PERMISSION_PROFILE_IDS["read-only"] ? "read-only" : "workspace-write");
    if (field !== profileField) { delete params[field]; changed = true; }
  }
  assertWorkspaceOutsideRefusedRoots(params, refusedRoots);
  const config = params.config;
  if (config && typeof config === "object" && !Array.isArray(config)
    && Object.keys(config).some(isOutpostManagedConfigKey)) {
    throw new Error("This Outpost refuses thread config that sets Codex sandbox or permission keys.");
  }
  if (mode === undefined && PROFILE_REQUIRED_METHODS.has(method)) mode = "read-only";
  if (mode !== undefined && params[profileField] !== OUTPOST_PERMISSION_PROFILE_IDS[mode]) {
    params[profileField] = OUTPOST_PERMISSION_PROFILE_IDS[mode];
    changed = true;
  }
  return changed ? JSON.stringify(message) : raw;
}
