import type { ForgeKind } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/** IPC names are behavior, kept out of the shared product catalog. */
export const FORGE_SETTINGS = {
  github: { statusMethod: "getGhStatus", pickMethod: "pickGhCommand" },
  gitlab: { statusMethod: "getGlabStatus", pickMethod: "pickGlabCommand" },
} as const satisfies Record<ForgeKind, {
  statusMethod: keyof DesktopApi;
  pickMethod: keyof DesktopApi;
}>;
