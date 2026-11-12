import { realpathSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, readMessages } from "./wire.js";
import { checkCodexSandbox } from "./sandbox-preflight.js";

export async function serve({ directory, workspace, home, command, profile }) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Headless currently supports Linux and macOS only");
  for (const value of [workspace, home, command]) {
    if (!value || !path.isAbsolute(value)) throw new Error("serve requires absolute --workspace, --codex-home and --codex-bin paths");
  }
  workspace = realpathSync(workspace);
  home = realpathSync(home);
  if (!statSync(workspace).isDirectory() || !statSync(home).isDirectory()) throw new Error("Workspace and Codex home must be directories");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  directory = realpathSync(directory);
  const roots = [directory, workspace, home];
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (roots[i] === roots[j] || roots[i].startsWith(roots[j] + path.sep) || roots[j].startsWith(roots[i] + path.sep)) {
        throw new Error("Workspace, Codex home and headless state must be separate, non-overlapping directories");
      }
    }
  }
  const socketPath = path.join(directory, "rpc.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new Error("Headless socket path exceeds 100 bytes; choose a shorter PWRAGENT_HOME");
  process.chdir(workspace);
  process.env.PWRAGENT_PROFILE = profile;
  process.env.CODEX_HOME = home;
  process.env.PWRAGENT_CODEX_HOME = home;
  process.env.PWRAGENT_CODEX_COMMAND = command;
  const owner = await import("../dist/index.js");
  // The OS releases this lock when its holder exits, so a replacement
  // container (PID 1 again) starts without manual cleanup.
  const lock = owner.acquireHeadlessOwnerLock(directory);
  let opened = false;
  let services;
  let server;
  let listening = false;
  let shutdown;
  let exitCode = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const sockets = new Set();
  const preflight = new AbortController();
  const stop = (error) => {
    preflight.abort();
    if (error) exitCode = 1;
    if (shutdown) return shutdown;
    shutdown = (async () => {
      if (listening) server.close();
      for (const socket of sockets) socket.destroy();
      try { if (opened) await owner.shutdownHeadlessHost("outpost-stop"); }
      finally {
        try { if (listening) { try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; } } }
        finally {
          lock.release();
          process.off("SIGTERM", signalStop);
          process.off("SIGINT", signalStop);
        }
      }
      resolveDone(exitCode);
    })();
    // Persistence/cleanup failure must fail the process, not become an
    // unhandled rejection that leaves a healthy-looking daemon running.
    shutdown.catch((failure) => { console.error(failure.message); resolveDone(1); });
    return shutdown;
  };
  const signalStop = () => { void stop(); };
  try {
    lock.record(owner.processRuntimeInstanceId());
    process.on("SIGTERM", signalStop);
    process.on("SIGINT", signalStop);
    const sandbox = await checkCodexSandbox({ command, home, workspace, signal: preflight.signal });
    if (shutdown) return await done;
    if (sandbox.status !== "ready") throw new Error(sandbox.error);
    opened = true;
    await owner.prepareOutpostProfile(profile);
    services = await owner.startHeadlessHost(undefined, { manageSignals: false, exitedRuntimeInstanceIds: lock.previousInstanceIds });
    if (shutdown) { await owner.shutdownHeadlessHost("outpost-startup-cancelled"); return await done; }
    server = net.createServer((socket) => {
      if (sockets.size >= 64) { socket.destroy(); return; }
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(60000, () => socket.destroy());
      let accepted = false;
      readMessages(socket, MAX_REQUEST_BYTES, (message) => {
        if (accepted) { socket.destroy(); return; }
        accepted = true;
        const respond = (response) => {
          if (socket.destroyed) return;
          const data = JSON.stringify(response) + "\n";
          if (Buffer.byteLength(data) > MAX_RESPONSE_BYTES) {
            socket.end(JSON.stringify({ error: "Response exceeds 32 MiB; inspect the thread using a compatible Codex client" }) + "\n");
          } else socket.end(data);
        };
        if (message.version !== 1 || typeof message.method !== "string") {
          respond({ error: "Unsupported headless protocol" });
          return;
        }
        Promise.resolve().then(() => {
          const params = message.params || {};
          return owner.handleOutpostCommand(services, message.method, params);
        })
          .then((result) => respond({ result }), (error) => respond({ error: error.message }));
      }, () => socket.destroy());
    });
    // Only the lock holder binds this socket, so one left by a dead owner is stale.
    try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { listening = true; resolve(); });
    });
    chmodSync(socketPath, 0o600);
    if (shutdown) { server.close(); return await done; }
    server.on("error", (error) => { void stop(error); });
    console.log(JSON.stringify({ ready: true, socket: socketPath }));
    return await done;
  } catch (error) {
    await stop(error);
    throw error;
  }
}
