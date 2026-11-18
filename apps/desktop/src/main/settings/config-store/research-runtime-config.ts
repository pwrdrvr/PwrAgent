import type { ResearchHarnessConfig } from "@pwragent/shared";
import type { DesktopConfigStore } from "./desktop-config-store";

/** Invalid edits must not admit a new process using retained executable settings. */
export function readResearchHarnessConfig(
  store: Pick<DesktopConfigStore, "read" | "fileStatus">,
): ResearchHarnessConfig | undefined {
  if (store.fileStatus().kind === "invalid") {
    throw new Error("Repair this profile's invalid config.toml before using the research Harness adapter");
  }
  return store.read("research").harness;
}
