import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_SETTINGS_RETIREMENTS,
  isPastReleaseSeries,
  readDesktopSettingsConfig,
  retireLegacyDesktopSettings,
} from "../settings/desktop-config";
import { parseTomlTables } from "../settings/toml-editor";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeConfig(text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-retire-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(configPath, text);
  return configPath;
}

const LEGACY_MARKDOWN_CONFIG = [
  "# Keep this comment",
  "[experimental]",
  "# pwragent-legacy-settings key=incremental_markdown_rendering shape=boolean used_through=1.4.10 kept_for_older_clients",
  "incremental_markdown_rendering = false",
  "markdown_math_rendering = false",
  "live_transcript_event_filtering = true",
  "",
].join("\n");

const prerelease = fc.option(
  fc.constantFrom("alpha.1", "beta.12", "rc.3"),
  { nil: undefined },
);
const version = fc.record({
  major: fc.nat({ max: 4 }),
  minor: fc.nat({ max: 9 }),
  patch: fc.nat({ max: 20 }),
  prerelease,
});

describe("legacy settings retirement", () => {
  it("retires exactly the versions in a release series after the kept one", () => {
    fc.assert(fc.property(version, fc.nat({ max: 4 }), fc.nat({ max: 9 }), (v, keptMajor, keptMinor) => {
      const text = `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ""}`;
      // Oracle: compare (major, minor) as a tuple; patch and prerelease never matter.
      const expected = v.major !== keptMajor ? v.major > keptMajor : v.minor > keptMinor;
      expect(isPastReleaseSeries(text, `${keptMajor}.${keptMinor}`)).toBe(expected);
    }));
  });

  it("never retires on a version it cannot parse", () => {
    for (const text of ["", "dev", "latest", "1", "v", "x.6.0"]) {
      expect(isPastReleaseSeries(text, "1.5")).toBe(false);
    }
  });

  it("registers the legacy Markdown and CPU trigger keys through the 1.5 series", () => {
    expect(LEGACY_SETTINGS_RETIREMENTS.map(({ legacy, keptThroughSeries }) =>
      [legacy.join("."), keptThroughSeries])).toEqual([
      ["experimental.incremental_markdown_rendering", "1.5"],
      ["experimental.markdown_math_rendering", "1.5"],
      ["general.hot_cpu_profiling_trigger_mode", "1.5"],
    ]);
  });

  it("leaves the file untouched through every 1.5.x release", () => {
    for (const appVersion of ["1.4.10", "1.5.0-alpha.1", "1.5.0", "1.5.37"]) {
      const configPath = writeConfig(LEGACY_MARKDOWN_CONFIG);
      expect(retireLegacyDesktopSettings(configPath, appVersion)).toEqual({ changed: false, retired: [] });
      expect(fs.readFileSync(configPath, "utf8")).toBe(LEGACY_MARKDOWN_CONFIG);
    }
  });

  it("copies an unmigrated value forward, then deletes the legacy key and its marker", () => {
    const configPath = writeConfig(LEGACY_MARKDOWN_CONFIG);
    const before = readDesktopSettingsConfig(configPath).general?.markdown;

    expect(retireLegacyDesktopSettings(configPath, "1.6.0-alpha.1")).toEqual({
      changed: true,
      retired: [
        "experimental.incremental_markdown_rendering",
        "experimental.markdown_math_rendering",
      ],
    });

    const text = fs.readFileSync(configPath, "utf8");
    expect(text).not.toContain("incremental_markdown_rendering");
    expect(text).not.toContain("markdown_math_rendering");
    expect(text).not.toContain("pwragent-legacy-settings");
    expect(text).toContain("# Keep this comment");
    expect(text).toContain("live_transcript_event_filtering = true");
    const tables = parseTomlTables(text, configPath);
    expect(tables["general.markdown"]).toEqual({
      incremental_rendering: false,
      math_rendering: false,
    });
    // The operator's choices read the same before and after.
    expect(readDesktopSettingsConfig(configPath).general?.markdown).toEqual(before);
    // A second launch finds nothing to do.
    expect(retireLegacyDesktopSettings(configPath, "1.6.0")).toEqual({ changed: false, retired: [] });
  });

  it("keeps the current value when both keys exist, since the current key already won", () => {
    const configPath = writeConfig([
      "[general.markdown]",
      "math_rendering = true",
      "",
      "[experimental]",
      "markdown_math_rendering = false",
      "",
    ].join("\n"));

    retireLegacyDesktopSettings(configPath, "2.0.0");

    const tables = parseTomlTables(fs.readFileSync(configPath, "utf8"), configPath);
    expect(tables["general.markdown"]).toEqual({ math_rendering: true });
    expect(tables.experimental?.markdown_math_rendering).toBeUndefined();
  });

  it("removes only the retired key's own marker, never another key's", () => {
    const foreignMarker =
      "# pwragent-legacy-settings key=token_miser_enabled shape=boolean used_through=1.1.0-alpha.1 kept_for_older_clients";
    const configPath = writeConfig([
      "[experimental]",
      foreignMarker,
      "markdown_math_rendering = false",
      "",
    ].join("\n"));

    retireLegacyDesktopSettings(configPath, "1.6.0");

    const text = fs.readFileSync(configPath, "utf8");
    expect(text).not.toContain("markdown_math_rendering");
    expect(text).toContain(foreignMarker);
  });

  it("does nothing to a config without legacy keys or a missing file", () => {
    const text = "[general]\nnotifications_enabled = true\n";
    const configPath = writeConfig(text);
    expect(retireLegacyDesktopSettings(configPath, "1.6.0")).toEqual({ changed: false, retired: [] });
    expect(fs.readFileSync(configPath, "utf8")).toBe(text);
    expect(retireLegacyDesktopSettings(path.join(path.dirname(configPath), "absent.toml"), "1.6.0"))
      .toEqual({ changed: false, retired: [] });
  });
});
