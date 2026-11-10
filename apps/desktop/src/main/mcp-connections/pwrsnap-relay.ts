import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";

/**
 * PwrSnap 1.3.0 and later serve MCP only over a protected Unix socket or
 * Windows named pipe. PwrAgent reaches it through `pwrsnap-mcp`, the relay
 * PwrSnap ships inside its own installation: PwrAgent starts the relay as a
 * local command, and PwrSnap asks the operator to approve each session in
 * its own window. There is no TCP listener, OAuth, or stored credential.
 */

const PROBE_TIMEOUT_MS = 1_000;
const WINDOWS_PIPE_ROOT = "\\\\.\\pipe\\";
const WINDOWS_PIPE_PREFIX = "pwrsnap-mcp-";

/**
 * The relay inside a PwrSnap installation, given the path the installer
 * left: `PwrSnap.app` on macOS, `PwrSnap.exe` on Windows, the executable
 * elsewhere. An AppImage has no relay PwrAgent can start.
 */
export function pwrSnapRelayPath(
  installedPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "darwin") {
    return join(installedPath, "Contents", "Resources", "pwrsnap-mcp");
  }
  if (platform === "win32") {
    return join(dirname(installedPath), "resources", "pwrsnap-mcp.exe");
  }
  if (basename(installedPath).toLowerCase().endsWith(".appimage")) return undefined;
  return join(dirname(installedPath), "resources", "pwrsnap-mcp");
}

/** The socket the relay connects to on macOS and Linux. */
export function pwrSnapUnixSocketPath(euid: number): string {
  return `/tmp/pwrsnap-mcp-${euid}/mcp.sock`;
}

/**
 * Whether PwrSnap is running with Local Agent Access on.
 *
 * The socket file outlives a PwrSnap that quit, so only a connection that
 * opens counts. The probe closes before sending anything; PwrSnap drops a
 * connection that never greets it, and approval is never asked for one.
 */
export async function isPwrSnapEndpointListening(options: {
  platform?: NodeJS.Platform;
  connectTo?: (path: string) => Promise<boolean>;
  listPipes?: () => Promise<string[]>;
} = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const connectTo = options.connectTo ?? probeLocalEndpoint;
  if (platform !== "win32") {
    const euid = process.geteuid?.();
    if (euid === undefined) return false;
    return await connectTo(pwrSnapUnixSocketPath(euid));
  }
  // The pipe is named for the account's SID, which Node cannot read. Another
  // account's pipe refuses this one, so a connection that opens is ours.
  let pipes: string[];
  try {
    pipes = await (options.listPipes ?? (async () => await readdir(WINDOWS_PIPE_ROOT)))();
  } catch {
    return false;
  }
  for (const name of pipes) {
    if (!name.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX)) continue;
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
