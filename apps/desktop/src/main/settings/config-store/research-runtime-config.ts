import type { ResearchHarnessConfig } from "@pwragent/shared/research-harness";
import type { DesktopSettingsConfig } from "../desktop-config";
import type { DesktopConfigStore } from "./desktop-config-store";

/** Invalid edits must not admit a new process using retained executable settings. */
export function readResearchHarnessConfig(
  store: Pick<DesktopConfigStore, "read" | "fileStatus">,
): ResearchHarnessConfig | undefined {
  return readResearchConfig(store).harness;
}

/** The whole research section: source, bridge and MathOS Platform. Refused while the file is invalid. */
export function readResearchConfig(
  store: Pick<DesktopConfigStore, "read" | "fileStatus">,
): NonNullable<DesktopSettingsConfig["research"]> {
  if (store.fileStatus().kind === "invalid") {
    throw new Error("Repair this profile's invalid config.toml before using the research Harness adapter");
  }
  return store.read("research");
}
