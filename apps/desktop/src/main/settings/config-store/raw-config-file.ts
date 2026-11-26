import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  applyDesktopSettingsPatch,
  parseDesktopSettingsToml,
  type DesktopSettingsConfig,
} from "../desktop-config";
import type { DesktopSettingsConfigPatch } from "@pwragent/shared/contracts/settings";
import { requireMessagingSafetyAcknowledgment } from "../messaging-safety";
import { deepFreeze } from "./config-domains";

type ParsedConfigText =
  | Readonly<{
      kind: "valid";
      config: DesktopSettingsConfig;
      contentHash: string;
    }>
  | Readonly<{
      kind: "invalid";
      contentHash: string;
      error: string;
    }>;

export type RawConfigFileObservation =
  | (ParsedConfigText & Readonly<{ observedAt: number }>)
  | Readonly<{ kind: "missing"; observedAt: number }>;

// The active profile and explicit bootstrap/profile readers share one parse
// per observed revision. Bound retention even when inspecting many profiles.
const MAX_RECENT_CONFIG_PATHS = 4;
const recentConfigParses = new Map<string, ParsedConfigText>();

export function readRawConfigFile(
  configPath: string,
  options?: { now?: () => number },
): RawConfigFileObservation {
  const observedAt = (options?.now ?? Date.now)();
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    recentConfigParses.delete(configPath);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", observedAt };
    }
    return {
      kind: "invalid",
      contentHash: "unreadable",
      error: error instanceof Error ? error.message : String(error),
      observedAt,
    };
  }

  return parseRawConfigText(text, configPath, observedAt);
}

export function parseRawConfigText(
  text: string,
  configPath: string,
  observedAt = Date.now(),
): ParsedConfigText & Readonly<{ observedAt: number }> {
  return { ...parseSavedConfigText(text, configPath), observedAt };
}

/** Immediate saved-file read with the legacy explicit-path error behavior. */
export function readSavedProfileConfig(configPath: string): Readonly<DesktopSettingsConfig> {
  if (!fs.existsSync(configPath)) {
    recentConfigParses.delete(configPath);
    return {};
  }
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    recentConfigParses.delete(configPath);
    throw error;
  }
  const parsed = parseSavedConfigText(text, configPath);
  if (parsed.kind === "invalid") throw new Error(parsed.error);
  return parsed.config;
}

function parseSavedConfigText(text: string, configPath: string): ParsedConfigText {
  const contentHash = createHash("sha256").update(text).digest("hex");
  let parsed = recentConfigParses.get(configPath);
  if (parsed?.contentHash !== contentHash) {
    try {
      parsed = {
        kind: "valid",
        config: deepFreeze(parseDesktopSettingsToml(text, configPath)),
        contentHash,
      };
    } catch (error) {
      parsed = {
        kind: "invalid",
        contentHash,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  recentConfigParses.delete(configPath);
  recentConfigParses.set(configPath, parsed);
  if (recentConfigParses.size > MAX_RECENT_CONFIG_PATHS) {
    const oldest = recentConfigParses.keys().next().value;
    if (oldest !== undefined) recentConfigParses.delete(oldest);
  }
  return parsed;
}

export function writeRawConfigPatch(
  configPath: string,
  patch: DesktopSettingsConfigPatch,
): ReturnType<typeof applyDesktopSettingsPatch> {
  return applyDesktopSettingsPatch(configPath, patch);
}

export function requireSavedMessagingSafetyAcknowledgment(configPath: string): void {
  // The watcher may still be catching up to another window or a local edit.
  // Check the current file, even when the running settings retain older data.
  const current = readRawConfigFile(configPath);
  requireMessagingSafetyAcknowledgment(current.kind === "valid"
    ? current.config.general?.messagingAcknowledgment?.acknowledgedAt
    : undefined);
}
