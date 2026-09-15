import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_LAYOUT_ARG_PREFIX,
  BOOTSTRAP_LAYOUT_DEFAULTS,
  layoutPreferencesAdditionalArguments,
  parseBootstrapLayoutPreferencesArg,
  readBootstrapLayoutPreferences,
  serializeBootstrapLayoutPreferences,
} from "../layout-prefs-bootstrap";

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-layout-boot-"));
});

afterEach(() => {
  fs.rmSync(configDir, { force: true, recursive: true });
});

function writeConfig(body: string): string {
  const configPath = path.join(configDir, "config.toml");
  fs.writeFileSync(configPath, body, "utf8");
  return configPath;
}

describe("readBootstrapLayoutPreferences", () => {
  it("reads both preferences from the profile config", () => {
    const configPath = writeConfig(
      "[ui]\ncontext_rail_pinned = false\nsidebar_hidden = true\n",
    );
    expect(readBootstrapLayoutPreferences(configPath)).toEqual({
      contextRailPinned: false,
      sidebarHidden: true,
    });
  });

  it("falls back per key, so a config that sets one keeps the other's default", () => {
    const configPath = writeConfig("[ui]\ncontext_rail_pinned = false\n");
    expect(readBootstrapLayoutPreferences(configPath)).toEqual({
      contextRailPinned: false,
      sidebarHidden: BOOTSTRAP_LAYOUT_DEFAULTS.sidebarHidden,
    });
  });

  it("returns the defaults for a missing config rather than throwing", () => {
    // The window must still open when the profile has never been written.
    expect(
      readBootstrapLayoutPreferences(path.join(configDir, "absent.toml")),
    ).toEqual(BOOTSTRAP_LAYOUT_DEFAULTS);
  });

  it("returns the defaults for a malformed config rather than throwing", () => {
    const configPath = writeConfig("[ui\ncontext_rail_pinned = \n");
    expect(readBootstrapLayoutPreferences(configPath)).toEqual(
      BOOTSTRAP_LAYOUT_DEFAULTS,
    );
  });
});

describe("the bootstrap argument", () => {
  it("round-trips both preferences", () => {
    const preferences = { contextRailPinned: false, sidebarHidden: true };
    expect(
      parseBootstrapLayoutPreferencesArg([
        serializeBootstrapLayoutPreferences(preferences),
      ]),
    ).toEqual(preferences);
  });

  it("is the single argument the window contributes, under the shared prefix", () => {
    // The preload decodes by this prefix and cannot import this module, so
    // the prefix and the payload shape are the contract between them.
    const args = layoutPreferencesAdditionalArguments({
      contextRailPinned: true,
      sidebarHidden: false,
    });
    expect(args).toHaveLength(1);
    expect(args[0].startsWith(BOOTSTRAP_LAYOUT_ARG_PREFIX)).toBe(true);
    expect(JSON.parse(args[0].slice(BOOTSTRAP_LAYOUT_ARG_PREFIX.length))).toEqual({
      contextRailPinned: true,
      sidebarHidden: false,
    });
  });

  it("ignores unrelated arguments", () => {
    expect(
      parseBootstrapLayoutPreferencesArg([
        "--pwragent-appearance={\"theme\":\"dark\"}",
        "--pwragent-home-dir=\"/Users/fixture\"",
      ]),
    ).toBeUndefined();
  });

  it("substitutes a default for a non-boolean, so a stale payload cannot hide the rail", () => {
    expect(
      parseBootstrapLayoutPreferencesArg([
        `${BOOTSTRAP_LAYOUT_ARG_PREFIX}{"sidebarHidden":"yes"}`,
      ]),
    ).toEqual(BOOTSTRAP_LAYOUT_DEFAULTS);
  });

  it("reports unparseable JSON as absent, like an argv carrying no hint", () => {
    // `undefined` means "this argv told me nothing", which is the same answer
    // as a missing argument; the preload's own decoder collapses both to the
    // defaults at its single call site.
    expect(
      parseBootstrapLayoutPreferencesArg([`${BOOTSTRAP_LAYOUT_ARG_PREFIX}{`]),
    ).toBeUndefined();
  });
});
