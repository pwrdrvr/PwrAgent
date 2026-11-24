import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ResearchHarnessConfig } from "@pwragent/shared/research-harness";
import type { ResearchHarnessConnection } from "@pwragent/owner-core/research-harness-service";
import { object } from "@pwragent/owner-core/research-harness-records";
import { terminateOwnedProcessTree } from "../process-tree";

const MAX_FRAME_BYTES = 512_000;
/** Protocol-only stdout; bounded requests and frames; diagnostics are drained without persisting secrets. */
export function openResearchHarnessProcess(config: ResearchHarnessConfig, cwd: string,
  call: (method: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, onError: (error: unknown) => void): ResearchHarnessConnection {
  if (!path.isAbsolute(config.command) || !Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) throw new Error("Configure an absolute Harness bridge executable and an argument array");
  // The optional bridge is trusted installed code, but receives no provider keys or ambient app settings.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(config.command, config.args, { cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: "pipe" });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const inbound = new Set<string>();
  const seenInbound = new Set<string>();
  const abort = new AbortController();
  let nextId = 0, buffer = "", closed = false;
  const decoder = new StringDecoder("utf8");
  let cleanup: Promise<void> = Promise.resolve();
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    abort.abort();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
    cleanup = terminateOwnedProcessTree(child, { gracefulTimeoutMs: 500, forceTimeoutMs: 1500 });
    void cleanup.catch(onError);
  };
  const write = (value: unknown) => {
    const frame = JSON.stringify(value);
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("Harness frame exceeds its bound");
    child.stdin.write(`${frame}\n`, (error) => { if (error) fail(new Error("Harness input pipe closed")); });
  };
  const receive = (line: string) => {
    const frame = object(JSON.parse(line));
    if (frame.jsonrpc !== "2.0") throw new Error("Invalid Harness JSON-RPC version");
    if (typeof frame.method === "string") {
      // String IDs are bridge-to-owner calls; numeric IDs are owner-to-bridge calls.
      if (typeof frame.id !== "string" || frame.id.length > 100 || inbound.size >= 8 || seenInbound.size >= 10_000 || seenInbound.has(frame.id)) throw new Error("Invalid Harness callback identity");
      const id = frame.id;
      seenInbound.add(id);
      inbound.add(id);
      void Promise.resolve().then(() => call(frame.method as string, object(frame.params), abort.signal)).then((result) => {
        if (!closed) write({ jsonrpc: "2.0", id, result });
      }, () => { if (!closed) write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Research model call failed or was fenced by its owner" } }); })
        .catch(() => fail(new Error("Harness callback transport failed"))).finally(() => inbound.delete(id));
      return;
    }
    if (typeof frame.id !== "number" || !pending.has(frame.id)) throw new Error("Unexpected Harness response identity");
    if (Object.hasOwn(frame, "error") === Object.hasOwn(frame, "result")) throw new Error("Harness response must have exactly one result or error");
    const p = pending.get(frame.id)!;
    clearTimeout(p.timer); pending.delete(frame.id);
    if (frame.error !== undefined) p.reject(new Error("Harness bridge refused the request"));
    else if (Object.hasOwn(frame, "result")) p.resolve(frame.result);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer += decoder.write(chunk);
    try {
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Harness frame exceeds its bound");
        receive(line);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new Error("Harness unterminated frame exceeds its bound");
    } catch { fail(new Error("Malformed or oversized Harness protocol frame")); }
  });
  child.stderr.resume();
  child.once("error", () => fail(new Error("Harness bridge failed to launch")));
  child.once("close", () => fail(new Error("Harness bridge exited; remote work may still be running")));
  child.stdin.on("error", () => fail(new Error("Harness input pipe failed")));
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      if (closed || pending.size >= 16) { reject(new Error("Harness transport is closed or at capacity")); return; }
      const id = ++nextId;
      const timer = setTimeout(() => fail(new Error("Harness response timed out; outcome unknown")), 30_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      try { write({ jsonrpc: "2.0", id, method, params }); } catch { fail(new Error("Harness request could not be written")); }
    }),
    close: () => { fail(new Error("Harness transport closed by its owner")); return cleanup; },
  };
}
