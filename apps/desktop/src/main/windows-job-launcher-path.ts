import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDevelopmentRuntime, runtimeResourcesPath } from "./runtime-resources";

export function windowsGitJobLauncher(): string | undefined {
  const resources = runtimeResourcesPath();
  const directory = resources && !isDevelopmentRuntime()
    ? path.join(resources, "app.asar.unpacked/out/main")
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/main");
  const launcher = path.join(directory, "pwragent-windows-job.exe");
  return existsSync(launcher) ? launcher : undefined;
}
