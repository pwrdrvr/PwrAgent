import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * PwrSnap 1.3.0 and PwrGit 0.56.0 serve MCP only over a protected Unix
 * socket or Windows named pipe. PwrAgent reaches each through the relay the
 * app ships inside its own installation (`pwrsnap-mcp`, `pwrgit-mcp`):
 * PwrAgent starts the relay as a local command, and the app asks the
 * operator to approve each session in its own window. There is no TCP
 * listener, OAuth, or stored credential.
 */
export type PwrSuiteRelayApp = "pwrsnap" | "pwrgit";

const APP_NAMES: Record<PwrSuiteRelayApp, string> = {
  pwrsnap: "PwrSnap",
  pwrgit: "PwrGit",
};

/** The first release of each app that ships the relay. */
export const PWRSUITE_RELAY_MIN_VERSION: Record<PwrSuiteRelayApp, string> = {
  pwrsnap: "1.3.0",
  pwrgit: "0.56.0",
};

const PROBE_TIMEOUT_MS = 1_000;
const WINDOWS_PIPE_ROOT = "\\\\.\\pipe\\";

/** Where each app's installer puts it, in the order PwrAgent looks. */
export function defaultPwrSuiteInstallPaths(
  app: PwrSuiteRelayApp,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const name = APP_NAMES[app];
  if (platform === "darwin") {
    return [`/Applications/${name}.app`, join(homedir(), "Applications", `${name}.app`)];
  }
  if (platform === "win32") {
    return [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", name, `${name}.exe`) : "",
      process.env.ProgramFiles ? join(process.env.ProgramFiles, name, `${name}.exe`) : "",
      process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"]!, name, `${name}.exe`) : "",
    ].filter(Boolean);
  }
  return [`/usr/bin/${app}`, `/opt/${name}/${app}`, join(homedir(), "Applications", `${name}.AppImage`)];
}

/**
 * The relay inside an installation, given the path the installer left:
 * `<Name>.app` on macOS, `<Name>.exe` on Windows, the executable elsewhere.
 * An AppImage has no relay PwrAgent can start.
 */
export function pwrSuiteRelayPath(
  app: PwrSuiteRelayApp,
  installedPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "darwin") {
    return join(installedPath, "Contents", "Resources", `${app}-mcp`);
  }
  if (platform === "win32") {
    return join(dirname(installedPath), "resources", `${app}-mcp.exe`);
  }
  if (basename(installedPath).toLowerCase().endsWith(".appimage")) return undefined;
  return join(dirname(installedPath), "resources", `${app}-mcp`);
}

/** The relay inside the first installation that has one. */
export function findPwrSuiteRelay(app: PwrSuiteRelayApp, installPaths: readonly string[]): string | undefined {
  for (const installedPath of installPaths) {
    const relay = pwrSuiteRelayPath(app, installedPath);
    if (relay && existsSync(relay)) return relay;
  }
  return undefined;
}

/** The socket the relay connects to on macOS and Linux. */
export function pwrSuiteUnixSocketPath(app: PwrSuiteRelayApp, euid: number): string {
  return `/tmp/${app}-mcp-${euid}/mcp.sock`;
}

/**
 * Whether the app is running with Local Agent Access on.
 *
 * The socket file outlives an app that quit, so only a connection that
 * opens counts. The probe closes before sending anything; the app drops a
 * connection that never greets it, and approval is never asked for one.
 */
export async function isPwrSuiteEndpointListening(app: PwrSuiteRelayApp, options: {
  platform?: NodeJS.Platform;
  connectTo?: (path: string) => Promise<boolean>;
  listPipes?: () => Promise<string[]>;
} = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const connectTo = options.connectTo ?? probeLocalEndpoint;
  if (platform !== "win32") {
    const euid = process.geteuid?.();
    if (euid === undefined) return false;
    return await connectTo(pwrSuiteUnixSocketPath(app, euid));
  }
  // The pipe is named for the account's SID, which Node cannot read. Another
  // account's pipe refuses this one, so a connection that opens is ours.
  let pipes: string[];
  try {
    pipes = await (options.listPipes ?? (async () => await readdir(WINDOWS_PIPE_ROOT)))();
  } catch {
    return false;
  }
  const prefix = `${app}-mcp-`;
  for (const name of pipes) {
    if (!name.toLowerCase().startsWith(prefix)) continue;
    if (name.includes("\\") || name.includes("/")) continue;
    if (await connectTo(`${WINDOWS_PIPE_ROOT}${name}`)) return true;
  }
  return false;
}

async function probeLocalEndpoint(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(path);
    const finish = (listening: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
