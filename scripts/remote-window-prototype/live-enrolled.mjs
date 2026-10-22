// Uses an explicitly enabled dev runtime adapter; never reads identity/config DBs.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchNative } from "./live-native.mjs";
import { LiveWindowSession } from "./live-session.mjs";
import { startViewer } from "./live-viewer-server.mjs";
const { values } = parseArgs({ options: {
  "runtime-ready": { type: "string" }, "source-executable": { type: "string" },
  output: { type: "string", default: ".local/remote-window/enrolled" }, "allow-fixture-input": { type: "boolean", default: false },
} });
if (!values["runtime-ready"]) throw new Error("Specify the exact runtime ready file printed by the opted-in development app.");
const ready = JSON.parse(await readFile(values["runtime-ready"], "utf8"));
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url) || !/^[0-9a-f]{64}$/.test(ready.token)) throw new Error("Invalid local runtime descriptor.");
const out = resolve(values.output); await mkdir(out, { recursive: true });
const began = Date.now(), cpuStart = process.cpuUsage();
let stopped = false, source, session, viewer;
async function bridge(method, params) {
  const response = await fetch(ready.url + "/" + method, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Pwrwin-Runtime-Token": ready.token,
  }, body: JSON.stringify(params), signal: AbortSignal.timeout(4000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Runtime request failed");
  return value;
}
async function stop() {
  if (stopped) return;
  stopped = true; session?.revoke(); await source?.close(); await viewer?.close();
  await writeFile(`${out}/result.json`, JSON.stringify({ measuredAt: new Date().toISOString(), role: ready.role,
    helperCpu: process.cpuUsage(cpuStart), helperMaxRssKiB: process.resourceUsage().maxRSS, elapsedMs: Date.now() - began,
    nativeLog: source?.log, session: session?.metrics, browser: viewer?.metrics }, null, 2));
}
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
try {
  if (ready.role === "source") {
    if (!values["source-executable"]) throw new Error("Source needs the explicit owned-fixture executable.");
    source = launchNative(resolve(values["source-executable"])); await source.ready;
    session = new LiveWindowSession({ owner: ready.localInstanceId, viewer: ready.peerId, source, control: values["allow-fixture-input"] });
    source.onStop = () => { void stop(); };
    const inflight = new Set();
    while (!stopped) {
      const batch = await bridge("receive", {});
      if (!batch.connected) session.disconnect();
      for (const request of batch.requests) {
        if (inflight.size >= 8) throw new Error("Local request budget exceeded");
        const work = (async () => {
          let result, error;
          try { result = await session.handle(request.peer, request.method, request.params); }
          catch (failure) { error = String(failure); }
          if (!stopped) await bridge("reply", { id: request.id, result, error });
        })();
        inflight.add(work);
        void work.catch(error => { console.error(String(error)); void stop(); }).finally(() => inflight.delete(work));
      }
    }
    await Promise.allSettled(inflight);
  } else if (ready.role === "viewer") {
    viewer = await startViewer({ out, request: (method, params) => bridge("rpc", { method, params }) });
    console.log(`Viewer ready: ${out}/ready.json. It uses only the configured enrolled peer.`);
  } else { throw new Error("Unknown runtime role"); }
} catch (error) { await stop(); throw error; }
