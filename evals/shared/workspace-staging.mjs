import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Canonicalize an existing or not-yet-created path by resolving the real path
 * of its nearest existing ancestor, matching Outpost's path canonicalization.
 */
export function canonicalPath(value) {
  let existing = path.resolve(value);
  const missing = [];
  if (process.platform === "win32") return existing;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing.reverse());
    } catch (error) {
      if ((error.code !== "ENOENT" && error.code !== "ENOTDIR") || existing === path.parse(existing).root) {
        throw error;
      }
      missing.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

export function isWithinPath(child, parent) {
  const c = canonicalPath(child);
  const p = canonicalPath(parent);
  if (process.platform === "win32") {
    const lc = c.toLowerCase();
    const lp = p.toLowerCase();
    return lc === lp || lc.startsWith(lp.endsWith(path.sep) ? lp : lp + path.sep);
  }
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Roots where Outpost's Codex sandbox refuses a workspace cwd (Codex home,
 * PwrAgent profile state, and optionally user home dirs).
 */
export function resolveRefusedWorkspaceRoots({
  env = process.env,
  hostHome = os.homedir(),
  pwragentHome = /** @type {string | undefined} */ (undefined),
  extraRefusedRoots = /** @type {string[]} */ ([]),
} = {}) {
  const roots = [];
  const add = (candidate) => {
    if (typeof candidate !== "string" || !candidate.trim()) return;
    const resolved = canonicalPath(candidate.trim());
    if (resolved === path.parse(resolved).root) return;
    if (!roots.includes(resolved)) roots.push(resolved);
  };

  const codexHome = env.CODEX_HOME?.trim() || (hostHome ? path.join(hostHome, ".codex") : undefined);
  add(codexHome);
  if (hostHome) {
    add(path.join(hostHome, ".codex"));
    add(path.join(hostHome, ".pwragent", "profiles"));
  }
  const activePwragentHome = pwragentHome || env.PWRAGENT_HOME?.trim();
  if (activePwragentHome) {
    add(path.join(activePwragentHome, "profiles"));
  }
  for (const extra of extraRefusedRoots) add(extra);
  return roots;
}

/**
 * Default parent directory for staged review workspaces, always outside
 * `~/.codex`, `$HOME`, `PWRAGENT_HOME`, and macOS `/private/var/folders`.
 */
export function defaultSafeWorkspaceParent({
  platform = process.platform,
  subdir = "pwragent-eval-workspaces",
} = {}) {
  const base = platform === "darwin" || platform === "linux"
    ? canonicalPath("/tmp")
    : canonicalPath(os.tmpdir());
  return path.join(base, subdir);
}

/**
 * Assert that a workspace staging directory will not trip Outpost's Codex
 * sandbox guard (`assertWorkspaceOutsideRefusedRoots`).
 */
export function assertSafeWorkspaceParent(candidate, options = {}) {
  const canonical = canonicalPath(candidate);
  const refused = resolveRefusedWorkspaceRoots(options);
  for (const root of refused) {
    if (isWithinPath(canonical, root) || isWithinPath(root, canonical)) {
      throw new Error(
        `Eval workspace staging path "${canonical}" overlaps refused root "${root}". `
        + "Stage eval workspaces outside CODEX_HOME (~/.codex) and PwrAgent profile state (for example under /tmp/pwragent-eval-workspaces).",
      );
    }
  }
  return canonical;
}

/**
 * Resolve the workspace staging parent for a run. If an explicit path is given,
 * validate it fail-closed; otherwise pick the safe default outside `~/.codex`.
 */
export function resolveSafeWorkspaceParent({
  requestedParent = /** @type {string | undefined} */ (undefined),
  env = process.env,
  hostHome = os.homedir(),
  pwragentHome = /** @type {string | undefined} */ (undefined),
  platform = process.platform,
  subdir = "pwragent-eval-workspaces",
} = {}) {
  const candidate = requestedParent?.trim()
    ? path.resolve(requestedParent.trim())
    : defaultSafeWorkspaceParent({ platform, subdir });
  return assertSafeWorkspaceParent(candidate, { env, hostHome, pwragentHome });
}
