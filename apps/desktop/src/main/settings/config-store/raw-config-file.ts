import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  applyDesktopSettingsPatch,
  parseDesktopSettingsToml,
  type DesktopSettingsConfig,
} from "../desktop-config";
import type { DesktopSettingsConfigPatch } from "@pwragent/shared/contracts/settings";
import { requireMessagingSafetyAcknowledgment } from "../messaging-safety";

export type RawConfigFileObservation =
  | Readonly<{
      kind: "valid";
      config: DesktopSettingsConfig;
      contentHash: string;
      observedAt: number;
    }>
  | Readonly<{
      kind: "missing";
      observedAt: number;
    }>
  | Readonly<{
      kind: "invalid";
      contentHash: string;
      error: string;
      observedAt: number;
    }>;

export function readRawConfigFile(
  configPath: string,
  options?: { now?: () => number },
): RawConfigFileObservation {
  const observedAt = (options?.now ?? Date.now)();
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
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
): RawConfigFileObservation {
  const contentHash = hashConfigText(text);
  try {
    return {
      kind: "valid",
      config: parseDesktopSettingsToml(text, configPath),
      contentHash,
      observedAt,
    };
  } catch (error) {
    return {
      kind: "invalid",
      contentHash,
      error: error instanceof Error ? error.message : String(error),
      observedAt,
    };
  }
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

export function hashConfigText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
