import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pwrSuiteRelayPath, type PwrSuiteRelayApp } from "../../mcp-connections/pwrsuite-relay";

const directories: string[] = [];

/**
 * A PwrSnap or PwrGit install in a temp folder, with or without the relay it
 * ships. Gateway tests pass these instead of the default install paths, so
 * a result never depends on which release the test machine has installed.
 */
export function pwrSuiteInstall(app: PwrSuiteRelayApp, options: { relay?: boolean } = {}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pwragent-${app}-install-`));
  directories.push(directory);
  const name = app === "pwrsnap" ? "PwrSnap" : "PwrGit";
  const installed = path.join(
    directory,
    process.platform === "darwin" ? `${name}.app` : process.platform === "win32" ? `${name}.exe` : app,
  );
  if (process.platform === "darwin") fs.mkdirSync(installed);
  else fs.writeFileSync(installed, "");
  if (options.relay !== false) {
    const relay = pwrSuiteRelayPath(app, installed)!;
    fs.mkdirSync(path.dirname(relay), { recursive: true });
    fs.writeFileSync(relay, "", { mode: 0o755 });
  }
  return installed;
}

/** Gateway options with both apps installed, each with its relay. */
export function pwrSuiteInstallOptions(): {
  resolveInstallPaths: () => string[];
  resolvePwrGitInstallPaths: () => string[];
} {
  const pwrsnap = pwrSuiteInstall("pwrsnap");
  const pwrgit = pwrSuiteInstall("pwrgit");
  return { resolveInstallPaths: () => [pwrsnap], resolvePwrGitInstallPaths: () => [pwrgit] };
}

/** Removes every install this module created. Call from `afterEach`. */
export function removePwrSuiteInstalls(): void {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
