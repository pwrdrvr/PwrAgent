import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearUpdateHandoffMarker,
  shouldStepAsideForUpdateInstall,
  writeUpdateHandoffMarker,
} from "../update-handoff-marker";

const OLD_VERSION = "1.0.0-beta.1";
const NEW_VERSION = "1.0.0-beta.2";

let tmpHome: string;
let priorHome: string | undefined;

function markerFile(): string {
  return path.join(tmpHome, "update-handoff.json");
}

beforeEach(() => {
  priorHome = process.env.PWRAGENT_HOME;
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "pwragent-handoff-"));
  process.env.PWRAGENT_HOME = tmpHome;
});

afterEach(() => {
  if (priorHome === undefined) {
    delete process.env.PWRAGENT_HOME;
  } else {
    process.env.PWRAGENT_HOME = priorHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("update handoff marker", () => {
  it("does not step aside when no marker exists", () => {
    expect(shouldStepAsideForUpdateInstall(OLD_VERSION)).toBe(false);
  });

  it("steps aside on a fresh handoff while still on the old version", () => {
    writeUpdateHandoffMarker(NEW_VERSION);
    expect(existsSync(markerFile())).toBe(true);
    expect(shouldStepAsideForUpdateInstall(OLD_VERSION)).toBe(true);
  });

  it("does not step aside — and clears the marker — once on the target version", () => {
    writeUpdateHandoffMarker(NEW_VERSION);
    expect(shouldStepAsideForUpdateInstall(NEW_VERSION)).toBe(false);
    expect(existsSync(markerFile())).toBe(false);
  });

  it("does not step aside for a stale marker and clears it", () => {
    // Hand-write an ancient timestamp so we exercise the TTL branch without
    // mocking the clock.
    writeFileSync(
      markerFile(),
      JSON.stringify({ targetVersion: NEW_VERSION, at: Date.now() - 60 * 60_000 }),
      "utf8",
    );
    expect(shouldStepAsideForUpdateInstall(OLD_VERSION)).toBe(false);
    expect(existsSync(markerFile())).toBe(false);
  });

  it("does not step aside for a corrupt marker and clears it", () => {
    writeFileSync(markerFile(), "{ not valid json", "utf8");
    expect(shouldStepAsideForUpdateInstall(OLD_VERSION)).toBe(false);
    expect(existsSync(markerFile())).toBe(false);
  });

  it("clearUpdateHandoffMarker removes the file", () => {
    writeUpdateHandoffMarker(NEW_VERSION);
    clearUpdateHandoffMarker();
    expect(existsSync(markerFile())).toBe(false);
  });
});
