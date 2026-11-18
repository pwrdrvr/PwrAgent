import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, workerData } from "node:worker_threads";

const root = fileURLToPath(new URL("../", import.meta.url));

// package.json gates dependency-only workspace installs on this local marker.
// A packed install and the package builder both supply it before calling here.
if (!existsSync(path.join(root, "dist/runtime.json"))) throw new Error("The Outpost package is incomplete: runtime.json is missing.");
if (!["linux", "darwin"].includes(process.platform)) throw new Error("Outpost supports Linux and macOS.");

if (workerData?.kind === "pwragent-native-helper") {
  const { buildMcpIpcRelay } = await import("./build-mcp-ipc-relay.mjs");
  const helperDirectory = path.join(root, "resources/mcp-ipc-relay");
  mkdirSync(helperDirectory, { recursive: true });
  buildMcpIpcRelay({ outputRoot: root, packaged: true, reuse: true,
    destination: path.join(helperDirectory, "mcp-ipc-relay") });
} else {
  const { stageRuntime } = await import("./stage-runtime.mjs");
  // Both preparations use synchronous native probes. A worker lets the helper
  // run beside Git verification, while retaining every existing Git check.
  // An ESM data URL also works when npm's parent uses --eval/--input-type.
  // Keep Node's default flag inheritance, including memory/security options.
  const entry = new URL(`data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(import.meta.url)};`)}`);
  const worker = new Worker(entry, { workerData: { kind: "pwragent-native-helper" } });
  const native = new Promise((resolve, reject) => {
    let failure;
    worker.once("error", (error) => { failure = error; });
    // 'exit' is the final Worker event. Do not resolve on a message while its
    // compiler or filesystem work could still be running.
    worker.once("exit", (code) => {
      if (failure || code !== 0) reject(failure ?? new Error(`Native helper worker exited ${code}.`));
      else resolve();
    });
  });
  const git = stageRuntime({ manifestPath: path.join(root, "resources/custom-git-runtime.json"),
    platform: process.platform, arch: process.arch, output: path.join(root, "resources/git"), cache: process.env.PWRGIT_RUNTIME_CACHE });
  // A failure must still join the other owner before npm/build can tear down
  // its files. Never terminate a compiler because the other preparation failed.
  const results = await Promise.allSettled([native, git]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
