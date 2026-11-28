import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, realpath, rmdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { nativeStdioRelayPath } from "../native-relay-path";

export const CODEX_AGENT_TOOL_SERVER_NAME = "pwragent_apps";
export const CODEX_AGENT_TOOL_GRANT = "PWRAGENT_CODEX_MCP_GRANT";
const RELAY_MODE = "--codex-stdio";
const PREFACE_BYTES = 53;
const MAX_PENDING_ADMISSIONS = 16;
const MAX_CONNECTIONS = 1024;
const PROBE_TIMEOUT = 3000;
const runProbe = promisify(execFile);
const processIdentity = /^[1-9]\d*:[1-9]\d*$/u;
const registrationPreface = /^PWA-MCP1 ([a-zA-Z0-9_-]{43})\n$/u;

export type CodexAgentToolStdioConfig = {
  command: string;
  args: [string, string];
  env: Record<string, string>;
};
export type CodexIpcConnection = (stream: Duplex, token: string, isAuthorized: () => boolean) => Promise<void>;
export type CodexIpcListener = Pick<CodexAgentToolIpc, "configuration" | "revoke" | "close">
  & Partial<Pick<CodexAgentToolIpc, "bindRuntime">>;

export type OwnedCodexProcess = { child: ChildProcess; isCurrent: () => boolean };
type RegisteredRuntime = { process: OwnedCodexProcess; identity: string; sockets: Set<Socket> };
type Registration = { runtime?: RegisteredRuntime; binding?: { child: ChildProcess } };

// The thread config crosses the Codex client adapter before reaching the
// selected App Server generation. Find the issuing owner by its run endpoint.
const listeners = new Map<string, CodexAgentToolIpc>();
const rootProbes = new WeakMap<ChildProcess, Promise<string>>();

export async function bindCodexAgentToolRuntime(
  params: unknown,
  readOwnedProcess: () => OwnedCodexProcess | undefined,
): Promise<void> {
  const request = params as { config?: { mcp_servers?: Record<string, Partial<CodexAgentToolStdioConfig>> } } | undefined;
  const server = request?.config?.mcp_servers?.[CODEX_AGENT_TOOL_SERVER_NAME];
  const [mode, endpoint] = Array.isArray(server?.args) ? server.args : [];
  const token = server?.env?.[CODEX_AGENT_TOOL_GRANT];
  if (mode !== RELAY_MODE || typeof token !== "string" || typeof endpoint !== "string") return;
  const listener = listeners.get(endpoint);
  const owned = readOwnedProcess();
  if (!listener || !owned) throw new Error("PwrAgent MCP requires a local owned Codex App Server.");
  await listener.bindRuntime(token, owned);
}

export function matchesCodexRelayAncestry(root: string, ancestry: readonly string[]): boolean {
  // The connector must be a descendant, with at most three intervening wrappers.
  return ancestry.length <= 5 && ancestry.slice(1).includes(root);
}

export class CodexAgentToolIpc {
  private readonly sockets = new Set<Socket>();
  private readonly grants = new Map<string, Registration>();
  private readonly server = createServer({ pauseOnConnect: true }, (socket) => this.accept(socket));
  private pending = 0;
  private directory?: string;
  private endpoint?: string;
  private starting?: Promise<string>;
  private closed = false;

  constructor(
    private readonly onConnection: CodexIpcConnection,
    private readonly executable: () => string = nativeStdioRelayPath,
  ) {}

  async configuration(token: string): Promise<CodexAgentToolStdioConfig> {
    if (this.closed) throw new Error("PwrAgent MCP is shutting down.");
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("PwrAgent tools via MCP require verified local Codex process ancestry, currently available on macOS and Linux.");
    }
    this.starting ??= this.start().catch(async (error) => {
      await this.removeDirectory();
      this.starting = undefined;
      throw error;
    });
    const endpoint = await this.starting;
    if (this.closed) throw new Error("PwrAgent MCP is shutting down.");
    if (!this.grants.has(token)) this.grants.set(token, {});
    return { command: this.executable(), args: [RELAY_MODE, endpoint], env: { [CODEX_AGENT_TOOL_GRANT]: token } };
  }

  async bindRuntime(token: string, owned: OwnedCodexProcess): Promise<void> {
    const registration = this.grants.get(token);
    if (!registration || !owned.isCurrent() || !owned.child.pid) {
      throw new Error("PwrAgent MCP registration or its owned Codex runtime has ended.");
    }
    const binding = registration.binding?.child === owned.child ? registration.binding : { child: owned.child };
    registration.binding = binding;
    let probe = rootProbes.get(owned.child);
    if (!probe) {
      probe = runProbe(this.executable(), ["--codex-root", String(owned.child.pid)], {
        timeout: PROBE_TIMEOUT, maxBuffer: 1024,
      }).then(({ stdout }) => {
        const identity = stdout.trim();
        if (!processIdentity.test(identity)) throw new Error("Invalid Codex root identity.");
        return identity;
      }).catch(() => {
        rootProbes.delete(owned.child);
        throw new Error("PwrAgent MCP could not verify the local Codex App Server process.");
      });
      rootProbes.set(owned.child, probe);
    }
    const identity = await probe;
    if (this.grants.get(token) !== registration || !owned.isCurrent()) {
      throw new Error("The Codex runtime changed before PwrAgent MCP could bind its registration.");
    }
    if (registration.binding !== binding) {
      throw new Error("A newer request is binding this PwrAgent MCP registration.");
    }
    const previous = registration.runtime;
    if (previous?.process.child === owned.child) return;
    for (const socket of previous?.sockets ?? []) socket.destroy();
    registration.runtime = { process: owned, identity, sockets: new Set() };
  }

  revoke(token: string): void {
    for (const socket of this.grants.get(token)?.runtime?.sockets ?? []) socket.destroy();
    this.grants.delete(token);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.grants.clear();
    await this.starting?.catch(() => undefined);
    if (this.endpoint) listeners.delete(this.endpoint);
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.removeDirectory();
  }

  private async start(): Promise<string> {
    // Resolve /tmp on macOS for the existing relay's symlink-free parent
    // walk. A short base also leaves room under Darwin's sun_path limit.
    this.directory = await mkdtemp(join(await realpath("/tmp"), "pwa-codex-"));
    const endpoint = join(this.directory, "mcp.sock");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(endpoint, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    try {
      await chmod(endpoint, 0o600);
    } catch (error) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      throw error;
    }
    this.endpoint = endpoint;
    listeners.set(endpoint, this);
    return endpoint;
  }

  private async removeDirectory(): Promise<void> {
    if (this.directory) await rmdir(this.directory).catch(() => undefined);
    this.directory = undefined;
  }

  private accept(socket: Socket): void {
    socket.on("error", () => socket.destroy());
    if (this.closed || this.pending >= MAX_PENDING_ADMISSIONS || this.sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    this.pending++;
    void this.admit(socket).then((admission) => {
      if (!admission || !admission.isAuthorized()) {
        socket.destroy();
        return;
      }
      return this.onConnection(socket, admission.token, admission.isAuthorized);
    }).catch(() => socket.destroy()).finally(() => this.pending--);
  }

  private async admit(socket: Socket) {
    const token = await readRegistrationPreface(socket);
    if (!token) return undefined;
    const root = this.grants.get(token)?.runtime;
    if (!root?.process.isCurrent()) return undefined;
    const ancestry = await inspectPeer(this.executable(), socket);
    if (!matchesCodexRelayAncestry(root.identity, ancestry)) return undefined;
    const isAuthorized = () => !socket.destroyed && this.grants.get(token)?.runtime === root && root.process.isCurrent();
    if (!isAuthorized()) return undefined;
    root.sockets.add(socket);
    socket.once("close", () => root.sockets.delete(socket));
    return { token, isAuthorized };
  }
}

export function readRegistrationPreface(socket: Duplex): Promise<string | undefined> {
  return new Promise((resolve) => {
    const finish = (token?: string) => {
      clearTimeout(timeout);
      socket.off("readable", read);
      socket.off("close", finishClosed);
      socket.off("end", finishClosed);
      resolve(token);
    };
    const read = () => {
      const bytes: Buffer | null = socket.read(PREFACE_BYTES);
      if (bytes) finish(registrationPreface.exec(bytes.toString("latin1"))?.[1]);
    };
    const finishClosed = () => finish();
    const timeout = setTimeout(finishClosed, PROBE_TIMEOUT);
    socket.on("readable", read);
    socket.once("close", finishClosed);
    socket.once("end", finishClosed);
    read();
  });
}

function inspectPeer(executable: string, socket: Socket): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // Use Node's documented stdio stream inheritance to duplicate the
    // accepted socket as fd 3. The helper never reads or writes socket bytes.
    const child = spawn(executable, ["--codex-peer"], {
      stdio: ["ignore", "pipe", "ignore", socket],
      timeout: PROBE_TIMEOUT,
    });
    let output = "";
    child.stdout!.setEncoding("ascii").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024) child.kill();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const ancestry = output.trim().split("\n");
      if (code === 0 && ancestry.every((entry) => processIdentity.test(entry))) resolve(ancestry);
      else reject(new Error("Cannot verify PwrAgent MCP peer ancestry."));
    });
  });
}
