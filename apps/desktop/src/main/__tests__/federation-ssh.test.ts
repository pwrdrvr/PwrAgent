import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildFederationSshArgs,
  dialFederationSshEndpoint,
  isFederationSshEndpointUrl,
  parseFederationSshEndpoint,
} from "../federation/federation-ssh";

class FakeSshChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(child: FakeSshChild) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn = (command: string, args: string[]) => {
    calls.push({ command, args });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { calls, spawnFn };
}

describe("federation ssh endpoints", () => {
  it("recognizes ssh:// endpoint URLs", () => {
    expect(isFederationSshEndpointUrl("ssh://ops@gateway.lan")).toBe(true);
    expect(isFederationSshEndpointUrl("  SSH://gateway.lan  ")).toBe(true);
    expect(isFederationSshEndpointUrl("wss://gateway.example.com")).toBe(false);
  });

  it("parses user, host, port, and forward target", () => {
    expect(
      parseFederationSshEndpoint(
        "ssh://ops@gateway.lan:2222/?forward=127.0.0.1:47831",
      ),
    ).toEqual({
      user: "ops",
      host: "gateway.lan",
      sshPort: 2222,
      forwardHost: "127.0.0.1",
      forwardPort: 47831,
    });
  });

  it("defaults the forward target to the federation loopback listener", () => {
    expect(parseFederationSshEndpoint("ssh://gateway.lan")).toEqual({
      user: undefined,
      host: "gateway.lan",
      sshPort: undefined,
      forwardHost: "127.0.0.1",
      forwardPort: 47830,
    });
  });

  it.each([
    ["ssh://user:secret@gateway.lan", /password/],
    ["ssh://", /Invalid SSH federation endpoint URL|host/],
    ["ssh://gateway.lan/somewhere", /forward=host:port/],
    ["ssh://gateway.lan/?forward=nope", /host:port/],
    ["ssh://gateway.lan/?forward=127.0.0.1:99999", /forward port/],
    ["ssh://gateway.lan:0", /SSH port/],
    ["wss://gateway.example.com", /ssh:\/\/ scheme/],
    // Would reach ssh(1) as an option rather than a destination.
    ["ssh://-oProxyCommand=touch%20pwned", /starting with '-'/],
    ["ssh://-J%20evil.example", /starting with '-'/],
    ["ssh://-ohost@gateway.lan", /starting with '-'/],
    // Would turn the operator's SSH server into a port-scanning proxy.
    ["ssh://gateway.lan/?forward=10.0.0.9:22", /loopback/],
    ["ssh://gateway.lan/?forward=evil.example:443", /loopback/],
  ])("rejects %s", (url, message) => {
    expect(() => parseFederationSshEndpoint(url)).toThrow(message);
  });

  it("builds batch-mode ssh -W arguments without weakening host checks", () => {
    const args = buildFederationSshArgs(
      parseFederationSshEndpoint(
        "ssh://ops@gateway.lan:2222/?forward=127.0.0.1:47831",
      ),
    );
    expect(args).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-p",
      "2222",
      "-W",
      "127.0.0.1:47831",
      "ops@gateway.lan",
    ]);
    expect(args.join(" ")).not.toContain("StrictHostKeyChecking");
  });

  it("carries data both ways over the ssh stdio stream", async () => {
    const child = new FakeSshChild();
    const { calls, spawnFn } = fakeSpawn(child);
    const socket = dialFederationSshEndpoint(
      parseFederationSshEndpoint("ssh://gateway.lan"),
      { spawnFn },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("ssh");

    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    child.stdout.write(Buffer.from("from-gateway"));
    socket.write(Buffer.from("from-client"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(received).toString()).toBe("from-gateway");
    expect(child.stdin.read()?.toString()).toBe("from-client");
  });

  it("destroys the stream with the stderr tail when ssh fails", async () => {
    const child = new FakeSshChild();
    const failures: Error[] = [];
    const socket = dialFederationSshEndpoint(
      parseFederationSshEndpoint("ssh://gateway.lan"),
      {
        spawnFn: fakeSpawn(child).spawnFn,
        onFailure: (error) => failures.push(error),
      },
    );
    const closed = new Promise<Error>((resolve) => {
      socket.on("error", resolve);
    });
    child.stderr.write("Host key verification failed.\n");
    child.emit("close", 255, null);

    const error = await closed;
    expect(error.message).toContain("SSH federation tunnel closed");
    expect(error.message).toContain("Host key verification failed.");
    // The caller needs this: Node collapses the resulting socket EOF into a
    // generic "socket hang up" before the WebSocket upgrade rejects.
    expect(failures.map((entry) => entry.message)).toEqual([error.message]);
  });

  it("treats a clean ssh exit as a normal close, not a transport error", async () => {
    const child = new FakeSshChild();
    const failures: Error[] = [];
    const socket = dialFederationSshEndpoint(
      parseFederationSshEndpoint("ssh://gateway.lan"),
      {
        spawnFn: fakeSpawn(child).spawnFn,
        onFailure: (error) => failures.push(error),
      },
    );
    const errors: Error[] = [];
    socket.on("error", (error: Error) => errors.push(error));

    child.emit("close", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("does not emit an unhandled error on a clean exit with no error listener", async () => {
    const child = new FakeSshChild();
    dialFederationSshEndpoint(parseFederationSshEndpoint("ssh://gateway.lan"), {
      spawnFn: fakeSpawn(child).spawnFn,
    });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    child.emit("close", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("uncaughtException", onUncaught);

    expect(uncaught).toEqual([]);
  });

  it("kills the ssh child when the stream is destroyed", async () => {
    const child = new FakeSshChild();
    const socket = dialFederationSshEndpoint(
      parseFederationSshEndpoint("ssh://gateway.lan"),
      { spawnFn: fakeSpawn(child).spawnFn },
    );
    socket.on("error", () => undefined);
    socket.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.killed).toBe(true);
  });

  it("maps a missing ssh binary to a readable error", async () => {
    const child = new FakeSshChild();
    const socket = dialFederationSshEndpoint(
      parseFederationSshEndpoint("ssh://gateway.lan"),
      { spawnFn: fakeSpawn(child).spawnFn },
    );
    const failed = new Promise<Error>((resolve) => {
      socket.on("error", resolve);
    });
    const enoent = Object.assign(new Error("spawn ssh ENOENT"), {
      code: "ENOENT",
    });
    child.emit("error", enoent);

    expect((await failed).message).toContain("OpenSSH client");
  });
});
