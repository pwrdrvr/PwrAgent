import { closeSync, openSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { JobStore, privateDirectory } from "./store.js";
import { Runtime } from "./runtime.js";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, readMessages } from "./wire.js";

export async function serve({ directory, workspace, home, command }) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Headless currently supports Linux and macOS only");
  for (const value of [workspace, home, command]) {
    if (!value || !path.isAbsolute(value)) throw new Error("serve requires absolute --workspace, --codex-home and --codex-bin paths");
  }
  workspace = realpathSync(workspace);
  home = realpathSync(home);
  if (!statSync(workspace).isDirectory() || !statSync(home).isDirectory()) throw new Error("Workspace and Codex home must be directories");
  privateDirectory(directory);
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
  const lockPath = path.join(directory, "owner.lock");
  let lock;
  try { lock = openSync(lockPath, "wx", 0o600); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Headless owner lock already exists: ${lockPath}. See README crash recovery; never remove a live owner's lock.`, { cause: error });
    throw error;
  }
  let runtime;
  let server;
  let listening = false;
  let shutdown;
  let exitCode = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const sockets = new Set();
  const stop = (error) => {
    if (error) exitCode = 1;
    if (shutdown) return shutdown;
    shutdown = (async () => {
      if (listening) server.close();
      for (const socket of sockets) socket.destroy();
      try { await runtime?.stop(); } finally {
        closeSync(lock);
        unlinkSync(lockPath);
        process.off("SIGTERM", signalStop);
        process.off("SIGINT", signalStop);
        resolveDone(exitCode);
      }
    })();
    // Persistence/cleanup failure must fail the process, not become an
    // unhandled rejection that leaves a healthy-looking daemon running.
    shutdown.catch((failure) => { console.error(failure.message); resolveDone(1); });
    return shutdown;
  };
  const signalStop = () => { void stop(); };
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid }) + "\n");
    const store = new JobStore(directory, { version: 1, workspace, codexHome: home });
    runtime = new Runtime({ store, workspace, home, command,
      onFailure: (error) => { console.error(`Headless runtime stopped: ${error.message}`); void stop(error); } });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, codexPid: runtime.codex.child.pid }) + "\n");
    process.on("SIGTERM", signalStop);
    process.on("SIGINT", signalStop);
    await runtime.codex.initialize();
    if (shutdown) return done;
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
        Promise.resolve().then(() => runtime.handle(message.method, message.params))
          .then((result) => respond({ result }), (error) => respond({ error: error.message }));
      }, () => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { listening = true; resolve(); });
    });
    if (shutdown) { server.close(); return await done; }
    server.on("error", (error) => { void stop(error); });
    console.log(JSON.stringify({ ready: true, socket: socketPath, pid: process.pid }));
    return await done;
  } catch (error) {
    await stop(error);
    throw error;
  }
}
