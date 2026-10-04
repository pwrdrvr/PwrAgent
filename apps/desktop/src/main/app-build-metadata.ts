import { app } from "electron";
import type { AppBuildMetadata } from "../shared/app-metadata";
import { readAppBuildIdentity } from "./app-build-identity";
import { resolveApplicationVersion } from "./app-version";

let startupBuildMetadata: Promise<AppBuildMetadata> | undefined;

/** Share the running build's startup identity across diagnostic surfaces. */
export function resolveAppBuildMetadata(): Promise<AppBuildMetadata> {
  if (!startupBuildMetadata) {
    const applicationVersion = resolveApplicationVersion(app.getVersion());
    startupBuildMetadata = readAppBuildIdentity(app.isPackaged, app.getAppPath())
      .then((buildIdentity) => ({ applicationVersion, buildIdentity }));
  }
  return startupBuildMetadata;
}
