import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  parseDesktopSettingsToml,
  type DesktopSettingsConfig,
} from "../desktop-config";

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

export function hashConfigText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
