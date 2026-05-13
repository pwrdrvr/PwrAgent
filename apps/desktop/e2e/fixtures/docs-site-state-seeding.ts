import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
