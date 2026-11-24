import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDevelopmentRuntime, runtimeResourcesPath } from "./runtime-resources";

export function windowsGitJobLauncher(moduleUrl = import.meta.url): string | undefined {
  const resources = runtimeResourcesPath();
  const development = isDevelopmentRuntime();
  // Electron Vite emits shared main modules in out/main/chunks.
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const mainDirectory = path.basename(moduleDirectory) === "chunks" ? path.dirname(moduleDirectory) : moduleDirectory;
  const desktop = path.resolve(mainDirectory, "../..");
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
