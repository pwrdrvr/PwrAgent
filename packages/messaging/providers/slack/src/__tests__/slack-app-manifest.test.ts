import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MESSAGING_COMMAND_CATALOG } from "@pwragent/messaging-interface";
import {
  DEFAULT_SLACK_SLASH_COMMAND_PREFIX,
  SLACK_APP_MANIFEST_BOT_EVENTS,
  SLACK_APP_MANIFEST_BOT_SCOPES,
  SLACK_APP_MANIFEST_VERSION,
  buildOfficialSlackAppManifest,
  slackAppManifestJson,
  slackAppManifestYaml,
} from "../slack-app-manifest.ts";
import {
  SLACK_CREATE_APP_URL_BASE,
  buildSlackCreateAppUrl,
} from "../slack-create-app-url.ts";

const manifestsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../manifests",
);

describe("official Slack app manifest", () => {
  it("matches the versioned JSON fixture", () => {
    const fixture = readFileSync(
      path.join(manifestsDir, "pwragent-slack-app.v2.json"),
      "utf8",
    );
    expect(slackAppManifestJson()).toBe(fixture);
  });

  it("matches the versioned YAML fixture", () => {
    const fixture = readFileSync(
      path.join(manifestsDir, "pwragent-slack-app.v2.yaml"),
      "utf8",
    );
    expect(slackAppManifestYaml()).toBe(fixture);
  });

  it("registers every catalog verb under the default pwragent_ prefix", () => {
    const manifest = buildOfficialSlackAppManifest();
    expect(DEFAULT_SLACK_SLASH_COMMAND_PREFIX).toBe("pwragent_");
    expect(manifest.features.slash_commands.map((command) => command.command))
      .toEqual(
        MESSAGING_COMMAND_CATALOG.map(
          (command) => `/${DEFAULT_SLACK_SLASH_COMMAND_PREFIX}${command.verb}`,
        ),
      );
    expect(manifest.features.slash_commands).toHaveLength(9);
  });

  it("keeps PKCE, token rotation, and org deploy off", () => {
    const manifest = buildOfficialSlackAppManifest();
    expect(SLACK_APP_MANIFEST_VERSION).toBe(2);
    expect(manifest.oauth_config.pkce_enabled).toBe(false);
    expect(manifest.settings.token_rotation_enabled).toBe(false);
    expect(manifest.settings.org_deploy_enabled).toBe(false);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.features.app_home.home_tab_enabled).toBe(true);
    expect(manifest.features.agent_view.agent_description).toBe(
      "Run and supervise coding agents on your own computer from Slack.",
    );
    expect(manifest.oauth_config.scopes.bot).toEqual([
      ...SLACK_APP_MANIFEST_BOT_SCOPES,
    ]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      ...SLACK_APP_MANIFEST_BOT_EVENTS,
    ]);
    expect(JSON.stringify(manifest)).not.toContain("client_secret");
    expect(JSON.stringify(manifest)).not.toContain("xoxb-");
    expect(JSON.stringify(manifest)).not.toContain("xapp-");
  });
});

describe("buildSlackCreateAppUrl", () => {
  it("urlencodes the official JSON manifest", () => {
    const prepared = buildSlackCreateAppUrl();
    const parsed = new URL(prepared.url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.slack.com/apps");
    expect(parsed.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(parsed.searchParams.get("manifest_json") ?? "")).toEqual(
      buildOfficialSlackAppManifest(),
    );
    expect(prepared.oversized).toBe(false);
    expect(prepared.fullUrl).toBe(prepared.url);
    expect(prepared.url.startsWith(`${SLACK_CREATE_APP_URL_BASE}&manifest_json=`))
      .toBe(true);
  });

  it("falls back to the bare create-app page when the query is oversized", () => {
    const prepared = buildSlackCreateAppUrl({ maxLength: 80 });
    expect(prepared.oversized).toBe(true);
    expect(prepared.url).toBe(SLACK_CREATE_APP_URL_BASE);
    expect(prepared.fullUrl).toContain("manifest_json=");
    expect(JSON.parse(prepared.manifestJson)).toEqual(
      buildOfficialSlackAppManifest(),
    );
  });
});
