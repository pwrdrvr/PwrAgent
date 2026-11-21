import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { boatTunnelArgs, systemTunnelRuntime } from "../mcp-connections/boat-port-forward";

/**
 * The tunnel's real `ssh-keygen` and `ssh` on this machine, with the exact
 * argument list `forward_port` uses, against a port nothing listens on.
 *
 * Written for Windows, where Win32-OpenSSH refuses a private key other users
 * can read and has its own idea of the null device; it runs wherever the
 * OpenSSH client is installed. A closed port ends `ssh` before it reads the
 * key or a known-hosts file, so those are checked on their own: `ssh-keygen
 * -y` applies the same private-key permission check `ssh` does, and `ssh -G`
 * parses every option without connecting.
 */

const run = promisify(execFile);
const runtime = systemTunnelRuntime();
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map(async (directory) => await runtime.removeDirectory(directory)));
});

/** Option and permission failures `ssh` reports before or instead of connecting. */
const NOT_A_CONNECTION_ERROR = /bad configuration option|command-line line|unprotected private key|bad permissions|can't open user config|no such file|load key|keyword .* extra arguments|garbage at end/i;

/** `ssh -V`, quoted in each failure so it names the client that ran. */
async function sshVersion(): Promise<string | undefined> {
  try {
    return (await run("ssh", ["-V"], { windowsHide: true })).stderr.trim();
  } catch {
    // Windows ships the OpenSSH client and must have it; elsewhere it may be absent.
    return process.platform === "win32" ? "no ssh on PATH" : undefined;
  }
}

const version = await sshVersion();

describe.runIf(version !== undefined)("the system tunnel runtime", () => {
  it("makes a key ssh will load and starts ssh with options it accepts, failing only to connect", async () => {
    // On Windows, the client that applies Windows ACLs, not Git's MSYS ssh.
    if (process.platform === "win32") expect(version).toMatch(/^OpenSSH_for_Windows/);
    const directory = await runtime.makeDirectory();
    made.push(directory);
    const { publicKey, privateKeyPath } = await runtime.createKey(directory);
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ pwragent-forward$/);

    // Refused with "UNPROTECTED PRIVATE KEY FILE" when others can read it.
    const derived = await run("ssh-keygen", ["-y", "-f", privateKeyPath], { windowsHide: true })
      .catch((error: { stderr?: string }) => ({ stdout: "", stderr: error.stderr ?? String(error) }));
    expect(derived.stderr, version).not.toMatch(NOT_A_CONNECTION_ERROR);
    expect(derived.stdout.trim().split(" ").slice(0, 2), version).toEqual(publicKey.split(" ").slice(0, 2));

    const knownHostsPath = path.join(directory, "known_hosts");
    await runtime.writeFile(knownHostsPath, `bx_system ${publicKey}\n`);
    const closedPort = await runtime.freePort();
    const args = boatTunnelArgs({
      sandboxId: "bx_system",
      remotePort: 3000,
      localPort: await runtime.freePort(),
      target: { host: "127.0.0.1", port: closedPort, user: "user", hostKey: publicKey },
      privateKeyPath,
      knownHostsPath,
    });

    // Every option parsed as meant, the quoted path included.
    const resolved = await run("ssh", ["-G", ...args], { windowsHide: true });
    const setting = (name: string): string | undefined => resolved.stdout
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().startsWith(`${name} `))
      ?.slice(name.length + 1);
    expect(path.normalize(setting("userknownhostsfile") ?? ""), version).toBe(path.normalize(knownHostsPath));
    expect(setting("hostkeyalias")).toBe("bx_system");
    expect(setting("stricthostkeychecking")).toBe("true");
    expect(setting("port")).toBe(String(closedPort));

    // The known-hosts file reads as one entry for the sandbox's alias.
    const found = await run("ssh-keygen", ["-F", "bx_system", "-f", knownHostsPath], { windowsHide: true });
    expect(found.stdout).toContain("bx_system ssh-ed25519");

    const child = runtime.spawn(args);
    const { stderr } = await child.exited;
    expect(stderr, version).not.toMatch(NOT_A_CONNECTION_ERROR);
    expect(stderr, version).toMatch(new RegExp(`connect to host 127\\.0\\.0\\.1 port ${closedPort}: `, "i"));
  }, 40_000);
});
