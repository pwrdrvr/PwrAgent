import fs from "node:fs";
// The Outpost runs on Linux and macOS only, and Codex receives POSIX paths,
// so the policy uses POSIX path rules on every platform that builds it.
import { posix as path } from "node:path";

/**
 * Codex sandbox policy for the contained Outpost.
 *
 * Codex runs model commands as the same Unix user as the Outpost, so file
 * modes cannot keep an agent out of the Outpost's own state. The profile
 * directory holds the local control socket (`state/headless/rpc.sock`), the
 * file-key secret (`state/headless-secret.key`), the state database and the
 * federation identity it encrypts. Codex's legacy `sandboxPolicy` grants read
 * access to the whole filesystem, so a read-only or workspace-write command
 * could read that key and decrypt every stored secret.
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
 * The PwrAgent paths agent commands must not read. Every profile lives under
 * `<root>/profiles`; the root itself also holds worktrees, so it stays
 * readable. Only the canonical path is denied: the sandbox masks the real
 * location, and bubblewrap aborts every command when a deny entry names a
 * symlink.
 */
export function resolveOutpostProtectedRoots(pwragentRoot: string): string[] {
  if (!path.isAbsolute(pwragentRoot)) throw new Error("The Outpost requires an absolute PWRAGENT_HOME.");
  return [canonicalOutpostPath(path.join(pwragentRoot, "profiles"))];
}

function assertProtectedRoots(protectedRoots: readonly string[]): void {
  if (protectedRoots.length === 0) throw new Error("The Outpost sandbox requires at least one protected root.");
  for (const root of protectedRoots) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root) {
      throw new Error("Outpost protected roots must be normalized absolute directories below the filesystem root.");
    }
  }
}

/**
 * Codex `-c` values (without the flag) defining both Outpost profiles and
 * selecting the read-only one by default. JSON strings are valid TOML basic
 * strings, so paths need no further escaping.
 */
export function buildOutpostCodexPermissionOverrides(protectedRoots: readonly string[]): string[] {
  assertProtectedRoots(protectedRoots);
  const denied = protectedRoots.map((root) => `${JSON.stringify(root)}="deny"`);
  const filesystem = (mode: OutpostSandboxMode) => `{${[
    "\":root\"=\"read\"",
    ...(mode === "workspace-write" ? ["\":workspace_roots\"={\".\"=\"write\"}"] : []),
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

// Codex grants write to each workspace root; one inside a protected root is
// more specific than its deny entry.
function assertWorkspaceOutsideProtectedRoots(params: Record<string, unknown>, protectedRoots: readonly string[]): void {
  const roots = [params.cwd, ...(Array.isArray(params.runtimeWorkspaceRoots) ? params.runtimeWorkspaceRoots : [])];
  for (const root of roots) {
    if (typeof root !== "string" || !root.trim()) continue;
    const candidate = canonicalOutpostPath(root.trim());
    if (protectedRoots.some((protectedRoot) => isWithin(candidate, protectedRoot))) {
      throw new Error("This Outpost refuses a working directory inside its own state.");
    }
  }
}

/**
 * Returns the outbound JSON-RPC rewriter for an Outpost Codex client. It
 * makes every sandbox selection an Outpost permission profile. It throws,
 * failing the request, when the message selects any other profile or
 * sandbox, carries thread config that could redefine one, or names a working
 * directory inside a protected root. Messages without a method (responses)
 * pass through.
 */
export function createOutpostCodexMessageRewriter(protectedRoots: readonly string[]): (raw: string) => string {
  assertProtectedRoots(protectedRoots);
  return (raw) => rewriteOutpostCodexMessage(raw, protectedRoots);
}

function rewriteOutpostCodexMessage(raw: string, protectedRoots: readonly string[]): string {
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
  assertWorkspaceOutsideProtectedRoots(params, protectedRoots);
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
