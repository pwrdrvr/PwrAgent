import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readProfilesRegistry,
  resolveProfilesRegistryPath,
  writeProfilesRegistry,
} from "../../src/main/profile";

// Test-only config seed helpers for the docs-site screenshot spec.
//
// The README screenshot spec already covers per-platform sqlite
// seeding (bindings, activity log, pairing tokens) through
// readme-state-seeding.ts. The docs-site captures are mostly Settings
// panels — those are renderer-routed and only need config.toml to be
// in a particular shape for the right fields to render with content.
//
// Each platform's "enabled = true" toggle is the minimum needed for
// its settings section to render its fields rather than just a
// disabled placeholder. No real tokens or secrets are seeded — fields
// render as empty, which is fine for "this is what the panel looks
// like" captures.

export function configTomlPathForHomeRoot(homeRoot: string): string {
  return path.join(homeRoot, ".pwragent/profiles/default/config.toml");
}

/**
 * A fixed home root for captures that print a path under it.
 *
 * The harness otherwise makes a fresh `mkdtemp` home per launch, and
 * Settings → Worktrees prints its effective path in full — once as
 * `/var/folders/…/T/pwragent-desktop-e2e-home-0iALmw/.pwragent/worktrees`,
 * then with a different six-character suffix on the next run. A fixed
 * path is the same on every run and every Mac, and reads as an example.
 * The launch's `close()` removes it; this clears whatever a failed launch
 * left behind, since the harness keeps a failed launch's home as evidence.
 */
export const DOCS_SITE_STABLE_HOME_ROOT = "/tmp/pwragent-docs-home";

export function resetDocsSiteStableHomeRoot(): string {
  rmSync(DOCS_SITE_STABLE_HOME_ROOT, { recursive: true, force: true });
  mkdirSync(DOCS_SITE_STABLE_HOME_ROOT, { recursive: true });
  return DOCS_SITE_STABLE_HOME_ROOT;
}

/**
 * Rewrite a profile's `last_used` in `profiles.toml`.
 *
 * Main stamps `last_used` with the wall clock as the profile opens, which is
 * before a spec can reach it, so Settings → Profiles showed a different
 * "Last used …" on every run. Call this after launch, then reload the window:
 * `App` reads the profile list once at startup.
 */
export function pinProfileLastUsed(
  homeRoot: string,
  profileName: string,
  lastUsed: Date,
): void {
  // Empty env: resolve under `homeRoot` even if the runner's shell exports
  // PWRAGENT_HOME, which the launch harness strips for the same reason.
  const options = { env: {}, homeDir: homeRoot };
  const registry = readProfilesRegistry(options);
  const entry = registry.profiles.find(
    (profile) => profile.name === profileName,
  );
  if (!entry?.last_used) {
    throw new Error(
      `pinProfileLastUsed: no last_used for profile "${profileName}" in ${resolveProfilesRegistryPath(options)}`,
    );
  }
  entry.last_used = lastUsed.toISOString();
  writeProfilesRegistry(registry, options);
}

/**
 * Seed a config.toml that enables every messaging adapter so each
 * platform's section in Settings → Messaging renders its full set of
 * fields. No tokens or credentials are written — every credential
 * field stays empty in the rendered panel.
 *
 * Used as the preLaunchHook for the per-platform settings-messaging-*
 * captures so each one can scroll directly to the platform's section
 * without having to drive the Enabled toggle in the UI first.
 */
export function seedAllMessagingProvidersEnabledConfig(homeRoot: string): void {
  const configPath = configTomlPathForHomeRoot(homeRoot);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    [
      "[messaging]",
      "enabled = true",
      "",
      "[messaging.telegram]",
      "enabled = true",
      "",
      "[messaging.discord]",
      "enabled = true",
      "",
      "[messaging.slack]",
      "enabled = true",
      // A saved name, so Connect opens past its Name step on Create. Unsaved,
      // the box would show main's suggestion, which carries the OS username
      // of whoever runs the capture.
      'app_name = "PwrAgent - riley"',
      "",
      "[messaging.mattermost]",
      "enabled = true",
      "",
      "[messaging.feishu]",
      "enabled = true",
      "",
      "[messaging.line]",
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );
}
