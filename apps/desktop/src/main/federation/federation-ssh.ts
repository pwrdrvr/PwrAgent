// SSH outer transport for the federation client. An `ssh://` gateway endpoint
// is dialed with the operator's system OpenSSH client using stdio forwarding
// (`ssh -W`), so ~/.ssh/config, key agents, and known_hosts all apply and
// PwrAgent never stores SSH credentials or weakens host-key checking. The
// resulting stdio stream carries the ordinary federation WebSocket, whose
// frames remain protected by the mandatory Noise IK channel — SSH only
// replaces the reachability hop, never the identity or encryption layer.
import {
  spawn as spawnChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { Duplex } from "node:stream";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:federation-ssh");

const DEFAULT_FORWARD_HOST = "127.0.0.1";
const DEFAULT_FORWARD_PORT = 47830;
const SSH_CONNECT_TIMEOUT_SECONDS = 10;
const STDERR_TAIL_LIMIT = 2_048;

export type FederationSshEndpoint = {
  user?: string;
  host: string;
  sshPort?: number;
  /** Loopback target on the gateway machine that sshd forwards to. */
  forwardHost: string;
  forwardPort: number;
};

export function isFederationSshEndpointUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("ssh://");
}

export function parseFederationSshEndpoint(url: string): FederationSshEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("Invalid SSH federation endpoint URL.");
  }
  if (parsed.protocol !== "ssh:") {
    throw new Error("SSH federation endpoints must use the ssh:// scheme.");
  }
  if (parsed.password) {
    throw new Error("SSH federation endpoints must not embed a password.");
  }
  if (!parsed.hostname) {
    throw new Error("SSH federation endpoints require a host.");
  }
  // `ssh://-oProxyCommand=...` parses as a hostname. Passed through as argv it
  // would reach ssh(1) as an option instead of a destination, so reject it
  // here rather than relying on argv position to keep it inert.
  if (parsed.hostname.startsWith("-") || parsed.username.startsWith("-")) {
    throw new Error(
      "SSH federation endpoints must not have a host or user starting with '-'.",
    );
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error(
      "SSH federation endpoints take the forward target as ?forward=host:port, not a path.",
    );
  }
  const forward = parsed.searchParams.get("forward");
  const { forwardHost, forwardPort } = forward
    ? parseForwardTarget(forward)
    : { forwardHost: DEFAULT_FORWARD_HOST, forwardPort: DEFAULT_FORWARD_PORT };
  return {
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    host: parsed.hostname,
    sshPort: parsed.port ? parsePort(parsed.port, "SSH port") : undefined,
    forwardHost,
    forwardPort,
  };
}

export function buildFederationSshArgs(
  endpoint: FederationSshEndpoint,
): string[] {
  return [
    // Fail closed instead of hanging on an interactive password or unknown
    // host-key prompt. Host-key verification itself stays at OpenSSH's
    // default strictness — PwrAgent never relaxes it.
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    ...(endpoint.sshPort !== undefined ? ["-p", String(endpoint.sshPort)] : []),
    "-W",
    `${endpoint.forwardHost}:${endpoint.forwardPort}`,
    endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host,
  ];
}

export type FederationSshSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export type FederationSshDialOptions = {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: FederationSshSpawn;
  /**
   * Called with the real ssh failure (auth, host key, timeout). Node turns the
   * resulting premature socket EOF into a generic "socket hang up" before the
   * WebSocket upgrade resolves, so the caller needs this to report anything
   * more useful than that.
   */
  onFailure?: (error: Error) => void;
};

/**
 * Open the SSH stdio forward for a federation endpoint. Returns the duplex
 * stream synchronously; connection, authentication, or host-key failures
 * surface as an error/close on the stream (with the bounded ssh stderr tail
 * in the message), which the federation client treats like any failed dial.
 */
export function dialFederationSshEndpoint(
  endpoint: FederationSshEndpoint,
  options: FederationSshDialOptions = {},
): Duplex {
  const command = options.command ?? "ssh";
  const spawnFn: FederationSshSpawn =
    options.spawnFn
    ?? ((cmd, args, spawnOptions) =>
      spawnChildProcess(cmd, args, {
        env: spawnOptions.env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams);
  const child = spawnFn(command, buildFederationSshArgs(endpoint), {
    env: buildPwrAgentChildProcessEnv(options.env ?? process.env),
  });
  return new SshStdioSocket(child, endpoint, options.onFailure);
}

// Wraps the ssh child's stdio as one duplex stream that quacks enough like a
// net.Socket for Node's HTTP client (no-op setTimeout/setNoDelay/etc.), so it
// can serve as the connection under a WebSocket upgrade.
class SshStdioSocket extends Duplex {
  private stderrTail = "";
  private exited = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    endpoint: FederationSshEndpoint,
    private readonly onFailure?: (error: Error) => void,
  ) {
    super();
    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) {
        child.stdout.pause();
      }
    });
    child.stdout.on("end", () => this.push(null));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(
        -STDERR_TAIL_LIMIT,
      );
    });
    child.on("error", (error) => {
      this.exited = true;
      this.fail(
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? new Error(
              "The ssh command was not found. Install the OpenSSH client to use ssh:// federation endpoints.",
            )
          : error instanceof Error
            ? error
            : new Error(String(error)),
      );
    });
    // "close" rather than "exit": it fires after stdio has been drained and
    // closed, so the stderr tail is complete and the readable side has already
    // ended. "exit" can fire with output still buffered.
    child.on("close", (code, signal) => {
      this.exited = true;
      if (code === 0 && !signal) {
        // Normal `ssh -W` teardown — the forwarded connection ended. Reporting
        // an Error here would make every graceful disconnect look like a
        // transport failure (and mark the endpoint failed in the UI).
        if (!this.destroyed) this.destroy();
        return;
      }
      const detail = this.stderrTail.trim();
      log.warn("federation ssh tunnel exited", {
        host: endpoint.host,
        code,
        signal,
      });
      this.fail(
        new Error(
          detail
            ? `SSH federation tunnel closed: ${detail}`
            : `SSH federation tunnel closed (exit ${code ?? signal ?? "unknown"}).`,
        ),
      );
    });
  }

  // Record before destroying: the consumer usually learns about the failure as
  // a generic socket error, and needs the recorded reason to report the cause.
  private fail(error: Error): void {
    this.onFailure?.(error);
    if (!this.destroyed) {
      this.destroy(error);
    }
  }

  _read(): void {
    this.child.stdout.resume();
  }

  _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.child.stdin.write(chunk, encoding, callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(callback);
  }

  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.exited) {
      this.child.kill();
    }
    callback(error);
  }

  // net.Socket surface expected by Node's HTTP client plumbing.
  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

// Loopback only. The documented topology forwards to the gateway's own
// loopback listener, and allowing an arbitrary target would turn the
// operator's SSH server into a port-scanning proxy for anyone who can get an
// endpoint into their config (e.g. via a pasted invite).
const LOOPBACK_FORWARD_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

function parseForwardTarget(value: string): {
  forwardHost: string;
  forwardPort: number;
} {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("SSH forward target must look like host:port.");
  }
  const forwardHost = value.slice(0, separator);
  const forwardPort = parsePort(value.slice(separator + 1), "forward port");
  if (!LOOPBACK_FORWARD_HOSTS.has(forwardHost.toLowerCase())) {
    throw new Error(
      "SSH federation endpoints may only forward to the gateway's loopback address.",
    );
  }
  return { forwardHost, forwardPort };
}

function parsePort(value: string, label: string): number {
  const port = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new Error(`Invalid SSH federation ${label}.`);
  }
  return port;
}
