#!/usr/bin/env node

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function discoverSigningIdentity(context) {
  const configuredIdentity = context.packager?.config?.mac?.identity;
  if (configuredIdentity === "-") return null;
  if (typeof configuredIdentity === "string" && configuredIdentity) {
    return configuredIdentity;
  }
  if (process.env.PWRAGENT_DOCK_PLUGIN_SIGN_IDENTITY) {
    return process.env.PWRAGENT_DOCK_PLUGIN_SIGN_IDENTITY;
  }
  if (process.env.CSC_NAME) return process.env.CSC_NAME;

  try {
    const output = execSync("security find-identity -v -p codesigning", {
      encoding: "utf8",
    });
    return output.match(/"(Developer ID Application: [^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function isReleaseContext(context) {
  if (process.env.CSC_LINK) return true;
  if (process.env.npm_lifecycle_event === "release") return true;
  return Boolean(context.packager?.config?.mac?.notarize);
}

export default async function afterPackSignDockTilePlugin(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const pluginPath = join(
    context.appOutDir,
    `${appName}.app`,
    "Contents",
    "PlugIns",
    "PwrAgentDockTilePlugin.plugin",
  );
  if (!existsSync(pluginPath)) {
    throw new Error(
      `[afterpack-sign-dock-tile-plugin] missing ${pluginPath}`,
    );
  }

  const identity = discoverSigningIdentity(context);
  if (identity === null && isReleaseContext(context)) {
    throw new Error(
      "[afterpack-sign-dock-tile-plugin] release build has no "
        + "Developer ID Application identity; refusing to leave the nested "
        + "Dock plug-in ad-hoc signed",
    );
  }

  const args = [
    "--sign",
    identity ?? "-",
    "--force",
    "--options",
    "runtime",
  ];
  if (identity !== null) args.push("--timestamp");
  args.push(pluginPath);

  console.log(
    `[afterpack-sign-dock-tile-plugin] signing with ${identity ?? "ad-hoc identity"}`,
  );
  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `[afterpack-sign-dock-tile-plugin] codesign failed (exit ${result.status})`,
    );
  }
}
