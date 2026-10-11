import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function launchNative(executable, { record = false } = {}) {
  if (process.platform !== "darwin") throw new Error("Live native source currently requires macOS.");
  const child = spawn("/usr/bin/time", ["-l", executable], { stdio: ["pipe", "pipe", "pipe"] });
  let readyResolve, readyReject, inputReply, closed = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Startup can fail before the caller finishes creating its private transport.
  void ready.catch(() => {});
  const readyTimer = setTimeout(() => readyReject(new Error("Native fixture readiness timeout")), 10000);
  const source = {
    ready, available: false, log: [], samples: [], onFrame: () => {}, onStop: () => {},
    next(key, requestId) { child.stdin.write(JSON.stringify({ kind: "next", key, requestId }) + "\n"); },
    input(command) {
      return new Promise((resolve, reject) => {
        if (inputReply) { reject(new Error("input_busy")); return; }
        const timer = setTimeout(() => { inputReply = undefined; reject(new Error("fixture_input_timeout")); }, 1000);
        inputReply = result => { clearTimeout(timer); inputReply = undefined; resolve(result); };
        child.stdin.write(JSON.stringify({ kind: "input", ...command }) + "\n");
      });
    },
    async close() {
      if (closed) return;
      closed = true; clearTimeout(readyTimer);
      child.stdin.end('{"kind":"stop"}\n');
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000); timer.unref();
      await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
      clearTimeout(timer); lines.close();
    },
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      if (line.length > 3 * 1024 * 1024) throw new Error("native_frame_limit");
      const value = JSON.parse(line);
      if (value.kind === "frame") {
        if (record && source.samples.length < 180) source.samples.push(value);
        source.onFrame(value);
      } else {
        if (source.log.length < 1000) source.log.push(value);
        if (value.kind === "ready") { source.available = true; clearTimeout(readyTimer); readyResolve(); }
        if (value.kind === "paused") source.available = false;
        if (value.kind === "resumed") source.available = true;
        if (value.kind === "input") inputReply?.(value);
        if (value.kind === "error") { readyReject(new Error(value.message)); source.onStop(); }
      }
    } catch (error) { readyReject(error); source.onStop(); void source.close(); }
  });
  child.stderr.on("data", data => { if (source.log.length < 1000) source.log.push({ stderr: String(data).slice(0, 2000) }); });
  child.on("error", error => { clearTimeout(readyTimer); readyReject(error); source.onStop(); });
  child.on("exit", code => { clearTimeout(readyTimer); readyReject(new Error(`native exited ${code}`)); source.onStop(); });
  child.stdin.on("error", () => source.onStop());
  return source;
}
