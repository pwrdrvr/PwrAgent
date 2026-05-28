import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDesktopSettingsPatch,
  invalidateAgentCoreGrokEnabledCache,
  resolveAgentCoreGrokEnabled,
  resolveDesktopConfigPath,
} from "../settings/desktop-config";
import { PWRAGENT_HOME_ENV } from "../profile";

const AGENT_CORE_GROK_ENV = "PWRAGENT_EXPERIMENTAL_AGENT_CORE_GROK";

describe("resolveAgentCoreGrokEnabled", () => {
  let tmpHome: string;
  let configPath: string;
  let priorHomeEnv: string | undefined;
  let priorProfileEnv: string | undefined;
  let priorFlagEnv: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-agent-core-grok-"));
    priorHomeEnv = process.env.HOME;
    priorProfileEnv = process.env[PWRAGENT_HOME_ENV];
    priorFlagEnv = process.env[AGENT_CORE_GROK_ENV];
    // Pin HOME so resolveDesktopConfigPath finds our tmp config dir.
    process.env.HOME = tmpHome;
    delete process.env[PWRAGENT_HOME_ENV];
    delete process.env[AGENT_CORE_GROK_ENV];
    configPath = resolveDesktopConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    invalidateAgentCoreGrokEnabledCache();
  });

  afterEach(() => {
    if (priorHomeEnv === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = priorHomeEnv;
    }
    if (priorProfileEnv === undefined) {
      delete process.env[PWRAGENT_HOME_ENV];
    } else {
      process.env[PWRAGENT_HOME_ENV] = priorProfileEnv;
    }
    if (priorFlagEnv === undefined) {
      delete process.env[AGENT_CORE_GROK_ENV];
    } else {
      process.env[AGENT_CORE_GROK_ENV] = priorFlagEnv;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    invalidateAgentCoreGrokEnabledCache();
  });

  it("defaults to disabled when nothing is configured", () => {
    expect(resolveAgentCoreGrokEnabled()).toBe(false);
  });

  it("honors the env var fast-path even when no config file exists", () => {
    // The env var must be read on every call so a runtime toggle wins
    // without waiting for any disk-cache invalidation.
    expect(
      resolveAgentCoreGrokEnabled({
        env: { [AGENT_CORE_GROK_ENV]: "1" } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
    expect(
      resolveAgentCoreGrokEnabled({
        env: { [AGENT_CORE_GROK_ENV]: "0" } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("reads the on-disk config when env var is unset", () => {
    fs.writeFileSync(
      configPath,
      "[experimental]\nagent_core_grok = true\n",
      "utf8",
    );
    expect(resolveAgentCoreGrokEnabled()).toBe(true);
  });

  it("memoizes the disk read across calls", () => {
    fs.writeFileSync(
      configPath,
      "[experimental]\nagent_core_grok = true\n",
      "utf8",
    );
    expect(resolveAgentCoreGrokEnabled()).toBe(true);
    // After the first read warms the cache, subsequent calls must not
    // hit `fs.readFileSync` again. Spy AFTER the warm-up so the prior
    // call's read doesn't show up in the assertion.
    const readSpy = vi.spyOn(fs, "readFileSync");
    for (let index = 0; index < 5; index += 1) {
      expect(resolveAgentCoreGrokEnabled()).toBe(true);
    }
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("memoizes false on missing config and stays cached", () => {
    // No file written — readDesktopSettingsConfig short-circuits on
    // existence check, but the cache should still keep us off disk on
    // subsequent calls.
    expect(resolveAgentCoreGrokEnabled()).toBe(false);
    const existsSpy = vi.spyOn(fs, "existsSync");
    for (let index = 0; index < 3; index += 1) {
      expect(resolveAgentCoreGrokEnabled()).toBe(false);
    }
    expect(existsSpy).not.toHaveBeenCalled();
    existsSpy.mockRestore();
  });

  it("invalidates the cache when applyDesktopSettingsPatch writes the flag", () => {
    // Seed disk + cache with the on-disk value.
    fs.writeFileSync(
      configPath,
      "[experimental]\nagent_core_grok = false\n",
      "utf8",
    );
    expect(resolveAgentCoreGrokEnabled()).toBe(false);

    // Run a settings-patch through the same routine the IPC handler uses.
    // The patch updates the on-disk file AND drops the cache so the very
    // next read sees the new value without waiting for any TTL.
    applyDesktopSettingsPatch(configPath, {
      experimental: { agentCoreGrok: true },
    });

    expect(resolveAgentCoreGrokEnabled()).toBe(true);
  });
});
