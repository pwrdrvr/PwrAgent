import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDevelopmentRuntime, runtimeResourcesPath } from "./runtime-resources";

export function windowsGitJobLauncher(): string | undefined {
  const resources = runtimeResourcesPath();
  const development = isDevelopmentRuntime();
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (development) {
    const devLauncher = path.join(desktop, ".local/windows-job-launcher/pwragent-windows-job.exe");
    if (existsSync(devLauncher)) return devLauncher;
  }
  const directory = resources && !development
    ? path.join(resources, "app.asar.unpacked/out/main")
    : path.join(desktop, "out/main");
  const launcher = path.join(directory, "pwragent-windows-job.exe");
  return existsSync(launcher) ? launcher : undefined;
}
