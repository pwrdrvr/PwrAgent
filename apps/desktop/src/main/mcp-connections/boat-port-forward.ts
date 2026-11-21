import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * A port in a Boat sandbox, reachable at 127.0.0.1 on this machine.
 *
 * Boat's own `boat forward` would need the API key in a child process's
 * environment, where any process of this user can read it. This opens the
 * tunnel with the system `ssh` instead: PwrAgent registers a key pair made
 * for this one tunnel over the API, and the child holds only that private
 * key, which opens nothing but the sandbox it was registered on.
 *
 * Rules held here, whatever the caller passes:
 * - the listener binds 127.0.0.1, never another address;
 * - the server must present the host key Boat returned for the sandbox;
 * - the user's ssh config, agent and known hosts are not read.
 */

/** Where Boat says a sandbox's SSH server is, and the key it must present. */
export type BoatTunnelTarget = { host: string; port: number; user: string; hostKey: string };

export type BoatTunnelChild = {
  kill(): void;
  /** Settles once the process is gone, with the end of what it wrote to stderr. */
  exited: Promise<{ stderr: string }>;
};

/** Everything that touches the machine, so a test can stand in for it. */
export type BoatTunnelRuntime = {
  /** Makes a key pair in `directory` and answers the public half. */
  createKey(directory: string): Promise<{ publicKey: string; privateKeyPath: string }>;
  freePort(): Promise<number>;
  spawn(args: readonly string[]): BoatTunnelChild;
  /** Whether something accepts connections on 127.0.0.1 at this port. */
  listening(port: number): Promise<boolean>;
  makeDirectory(): Promise<string>;
  removeDirectory(directory: string): Promise<void>;
  writeFile(file: string, content: string): Promise<void>;
  sleep(ms: number): Promise<void>;
};

export type BoatPortForward = {
  sandboxId: string;
  /** The port inside the sandbox. */
  port: number;
  localPort: number;
  url: string;
};

export class BoatTunnelError extends Error {}

const START_WAIT_MS = 20_000;
const START_POLL_MS = 200;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY_PATTERN = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]{16,}={0,3})(?: .*)?$/;

type Entry = BoatPortForward & {
  child: BoatTunnelChild;
  directory: string;
  /** The MCP sessions that asked for it. It closes with the last of them. */
  sessions: Set<string>;
};

/**
 * What Boat's `sshkey` answer says, checked before any of it reaches a
 * command line. An answer without a host key is refused: an unpinned
 * connection would trust whoever answered.
 */
export function readBoatTunnelTarget(answer: Record<string, unknown>): BoatTunnelTarget {
  const endpoint = typeof answer.sshEndpoint === "string" ? answer.sshEndpoint : undefined;
  const split = endpoint?.lastIndexOf(":") ?? -1;
  const host = endpoint ? endpoint.slice(0, split) : answer.machineIp;
  const port = endpoint ? Number(endpoint.slice(split + 1)) : 22;
  const user = answer.sshUser;
  const hostKey = typeof answer.hostKey === "string" ? HOST_KEY_PATTERN.exec(answer.hostKey.trim()) : null;
  if (
    typeof host !== "string"
    || (net.isIP(host) === 0 && !HOST_PATTERN.test(host))
    || !Number.isInteger(port) || port < 1 || port > 65_535
    || typeof user !== "string" || !USER_PATTERN.test(user)
  ) {
    throw new BoatTunnelError("Boat did not say where this sandbox's SSH server is, so no tunnel was opened.");
  }
  if (!hostKey) {
    throw new BoatTunnelError(
      "Boat did not return this sandbox's SSH host key, so PwrAgent could not verify the server and opened no tunnel.",
    );
  }
  return { host, port, user, hostKey: `${hostKey[1]} ${hostKey[2]}` };
}

/**
 * A path as the value of an `-o` option. ssh splits that value itself and
 * reads a backslash before a quote, a space or another backslash as an
 * escape: on Windows Server 2022 (OpenSSH_for_Windows_9.5p2) a
 * `GlobalKnownHostsFile` of `\\.\nul` arrived as `\.\nul`. Win32-OpenSSH
 * takes a forward slash as a separator, and no version reads one as an
 * escape. Arguments that are not `-o` values (`-F`, `-i`) reach ssh as given.
 */
export function sshOptionPath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return file.replaceAll("\\", "/");
  // Inside the quotes this is wrapped in, a backslash or quote of the path's
  // own must be escaped to reach ssh as itself.
  return file.replace(/["\\]/g, "\\$&");
}

/** The whole `ssh` command line for one tunnel. */
export function boatTunnelArgs(input: {
  sandboxId: string;
  remotePort: number;
  localPort: number;
  target: BoatTunnelTarget;
  privateKeyPath: string;
  knownHostsPath: string;
  /** Whose ssh reads it; this machine's unless a test says otherwise. */
  platform?: NodeJS.Platform;
}): string[] {
  const platform = input.platform ?? process.platform;
  // Quoted: a temporary directory may hold a space (a Windows user name).
  const knownHosts = `"${sshOptionPath(input.knownHostsPath, platform)}"`;
  return [
    "-N", "-T",
    // Not the user's config: no host alias, proxy or extra forward of theirs.
    "-F", platform === "win32" ? "\\\\.\\nul" : "/dev/null",
    "-i", input.privateKeyPath,
    "-p", String(input.target.port),
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    // Both known-hosts databases are the pinned file: ssh documents no way to
    // switch the global one off, and the machine's own may vouch for others.
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", `GlobalKnownHostsFile=${knownHosts}`,
    "-o", `HostKeyAlias=${input.sandboxId}`,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "GatewayPorts=no",
    "-o", "ForwardAgent=no",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`,
    `${input.target.user}@${input.target.host}`,
  ];
}

export class BoatPortForwards {
  private readonly entries = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<Entry>>();

  constructor(private readonly runtime: BoatTunnelRuntime = systemTunnelRuntime()) {}

  /** Open tunnels into any of these sandboxes. */
  list(sandboxIds: ReadonlySet<string>): BoatPortForward[] {
    return [...this.entries.values()].filter((entry) => sandboxIds.has(entry.sandboxId)).map(describe);
  }

  /**
   * Opens a tunnel, or answers the one already open for this sandbox port.
   * `register` hands the new public key to Boat and answers where to connect.
   */
  async open(request: {
    session: string;
    sandboxId: string;
    port: number;
    register: (publicKey: string) => Promise<BoatTunnelTarget>;
  }): Promise<BoatPortForward> {
    const key = `${request.sandboxId}:${request.port}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.sessions.add(request.session);
      return describe(existing);
    }
    let starting = this.starting.get(key);
    if (!starting) {
      starting = this.start(key, request).finally(() => this.starting.delete(key));
      this.starting.set(key, starting);
    }
    const entry = await starting;
    entry.sessions.add(request.session);
    return describe(entry);
  }

  async close(sandboxId: string, port: number): Promise<boolean> {
    return await this.end(this.entries.get(`${sandboxId}:${port}`));
  }

  /** Every tunnel into a sandbox that is stopping, resuming or going away. */
  async closeForSandbox(sandboxId: string): Promise<void> {
    await this.started((key) => key.startsWith(`${sandboxId}:`));
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.sandboxId === sandboxId)
      .map(async (entry) => await this.end(entry)));
  }

  /** A session ended: its tunnels close unless another session also holds them. */
  async closeForSession(session: string): Promise<void> {
    await this.started(() => true);
    await Promise.all([...this.entries.values()].map(async (entry) => {
      if (entry.sessions.delete(session) && entry.sessions.size === 0) await this.end(entry);
    }));
  }

  async closeAll(): Promise<void> {
    await this.started(() => true);
    await Promise.all([...this.entries.values()].map(async (entry) => await this.end(entry)));
  }

  /**
   * Waits for tunnels still starting, so a close also ends one that was on
   * its way up. Each `open` waiting on the same start resumes first and adds
   * its session before the close looks.
   */
  private async started(match: (key: string) => boolean): Promise<void> {
    await Promise.allSettled([...this.starting].filter(([key]) => match(key)).map(([, start]) => start));
  }

  private async start(
    key: string,
    request: { sandboxId: string; port: number; register: (publicKey: string) => Promise<BoatTunnelTarget> },
  ): Promise<Entry> {
    const runtime = this.runtime;
    const directory = await runtime.makeDirectory();
    let child: BoatTunnelChild | undefined;
    try {
      const { publicKey, privateKeyPath } = await runtime.createKey(directory);
      const target = await request.register(publicKey);
      const knownHostsPath = path.join(directory, "known_hosts");
      await runtime.writeFile(knownHostsPath, `${request.sandboxId} ${target.hostKey}\n`);
      const localPort = await runtime.freePort();
      child = runtime.spawn(boatTunnelArgs({
        sandboxId: request.sandboxId,
        remotePort: request.port,
        localPort,
        target,
        privateKeyPath,
        knownHostsPath,
      }));
      const started = child;
      const end: { gone?: { stderr: string } } = {};
      // Read through a call: the process may exit across any await below.
      const gone = (): { stderr: string } | undefined => end.gone;
      void started.exited.then((result) => {
        end.gone = result;
        // The sandbox stopped, or the network dropped: the tunnel is over.
        const entry = this.entries.get(key);
        if (entry?.child === started) {
          this.entries.delete(key);
          void runtime.removeDirectory(directory).catch(() => undefined);
        }
      });
      const failIfGone = (): void => {
        const result = gone();
        if (result) throw new BoatTunnelError(`The SSH tunnel did not start: ${lastLine(result.stderr)}`);
      };
      for (let waited = 0; ; waited += START_POLL_MS) {
        failIfGone();
        if (await runtime.listening(localPort)) break;
        if (waited >= START_WAIT_MS) {
          throw new BoatTunnelError("The SSH tunnel did not start in time. Check that the sandbox is running, then retry.");
        }
        await runtime.sleep(START_POLL_MS);
      }
      failIfGone();
      const entry: Entry = {
        sandboxId: request.sandboxId,
        port: request.port,
        localPort,
        url: `http://127.0.0.1:${localPort}`,
        child: started,
        directory,
        sessions: new Set(),
      };
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      child?.kill();
      await runtime.removeDirectory(directory).catch(() => undefined);
      throw error;
    }
  }

  private async end(entry: Entry | undefined): Promise<boolean> {
    if (!entry) return false;
    const key = `${entry.sandboxId}:${entry.port}`;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.child.kill();
    await this.runtime.removeDirectory(entry.directory).catch(() => undefined);
    return true;
  }
}

function describe(entry: Entry): BoatPortForward {
  return { sandboxId: entry.sandboxId, port: entry.port, localPort: entry.localPort, url: entry.url };
}

function lastLine(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).at(-1)?.trim();
  return line ? line.slice(0, 300) : "ssh exited without saying why.";
}

/**
 * The OpenSSH program to run. On Windows that is the system's Win32-OpenSSH
 * when it is installed, whatever else is on PATH: Git for Windows can put its
 * MSYS build (`OpenSSH_10.6p1`, seen on GitHub's windows-latest) first, and
 * the tunnel's arguments and key permissions were checked against the
 * system's (`OpenSSH_for_Windows_9.5p2`, Windows Server 2022).
 */
export function openSshCommand(
  name: "ssh" | "ssh-keygen",
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return name;
  const system = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", `${name}.exe`);
  return exists(system) ? system : name;
}

/** The real machine: `ssh-keygen`, `ssh`, and a temporary directory. */
export function systemTunnelRuntime(): BoatTunnelRuntime {
  return {
    createKey: async (directory) => {
      const privateKeyPath = path.join(directory, "key");
      await new Promise<void>((resolve, reject) => {
        execFile(
          openSshCommand("ssh-keygen"),
          ["-q", "-t", "ed25519", "-N", "", "-C", "pwragent-forward", "-f", privateKeyPath],
          { windowsHide: true },
          (error) => {
            if (!error) resolve();
            else reject(new BoatTunnelError("PwrAgent could not run ssh-keygen on this computer, so no tunnel was opened."));
          },
        );
      });
      return { publicKey: (await fs.readFile(`${privateKeyPath}.pub`, "utf8")).trim(), privateKeyPath };
    },
    freePort: async () => await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === "object") resolve(address.port);
          else reject(new BoatTunnelError("No local port was free for the tunnel."));
        });
      });
    }),
    spawn: (args) => {
      const child = spawn(openSshCommand("ssh"), [...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4_096);
      });
      const exited = new Promise<{ stderr: string }>((resolve) => {
        child.once("error", () => resolve({ stderr: "PwrAgent could not run ssh on this computer." }));
        child.once("close", () => resolve({ stderr }));
      });
      return { kill: () => void child.kill(), exited };
    },
    listening: async (port) => await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    }),
    makeDirectory: async () => await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-boat-forward-")),
    removeDirectory: async (directory) => await fs.rm(directory, { recursive: true, force: true }),
    writeFile: async (file, content) => await fs.writeFile(file, content, { mode: 0o600 }),
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
