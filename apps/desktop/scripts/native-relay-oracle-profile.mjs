// Test-only, opt-in diagnostics. Never imported by the production builder.
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export function appendNativeOracleTiming(record) {
  const file = process.env.PWRAGENT_NATIVE_ORACLE_PROFILE;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Bound diagnostics independently of captured compiler stdout/stderr.
  if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) return;
  fs.appendFileSync(file, JSON.stringify({ pid: process.pid, ...record }) + "\n");
}

export function profileNativeBuild(label, build) {
  if (!process.env.PWRAGENT_NATIVE_ORACLE_PROFILE) return build();
  const totals = new Map();
  const inspections = [];
  let inspectionsOmitted = 0;
  // Use originals so observation does not recursively enter filesystem hooks.
  const stat = fs.statSync;
  const realpath = fs.realpathSync;
  const identity = (target) => {
    try {
      const s = stat(target, { bigint: true });
      return { real: realpath(target), dev: String(s.dev), ino: String(s.ino),
        mode: String(s.mode), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
    } catch (error) { return { error: error.code }; }
  };
  const inspection = (command, args = []) => {
    // Never retain arbitrary compiler arguments, environments or command output.
    const tool = path.basename(command);
    const target = tool === "otool" && args.length === 2 && ["-L", "-l", "-D"].includes(args[0]) ? args[1]
      : tool === "ldd" && args.length === 1 ? args[0] : undefined;
    if (typeof target !== "string" || !path.isAbsolute(target)) return undefined;
    if (inspections.length >= 128 || target.length > 4096) { inspectionsOmitted++; return undefined; }
    return { command, mode: tool === "otool" ? args[0] : "probe", target, before: identity(target) };
  };
  const originals = [];
  const wrap = (object, name, classify, inspect) => {
    const original = object[name];
    const observed = function(...args) {
      const key = classify(...args);
      const detail = inspect?.(...args);
      const started = performance.now();
      let result;
      try { result = Reflect.apply(original, this, args); return result; }
      finally {
        const ms = performance.now() - started;
        const entry = totals.get(key) ?? { count: 0, ms: 0 };
        entry.count++;
        entry.ms += ms;
        totals.set(key, entry);
        if (detail) {
          inspections.push({ ...detail, after: identity(detail.target), ms,
            status: result?.status, signal: result?.signal, error: result?.error?.code,
            stdoutSha256: createHash("sha256").update(result?.stdout ?? "").digest("hex") });
        }
      }
    };
    // Preserve alternate native implementations and other function metadata.
    for (const key of Reflect.ownKeys(original)) {
      if (!["length", "name", "prototype", "caller", "arguments"].includes(key)) {
        Object.defineProperty(observed, key, Object.getOwnPropertyDescriptor(original, key));
      }
    }
    originals.push(() => { object[name] = original; });
    object[name] = observed;
  };
  wrap(childProcess, "spawnSync", (command, args = []) => {
    const tool = path.basename(command);
    const mode = args.includes("-###") ? "plan" : args.includes("-E") ? "preprocess"
      : tool === "otool" ? args[0] : tool === "cc" ? "compile" : "probe";
    return `${tool}:${mode}`;
  }, inspection);
  for (const name of ["statSync", "lstatSync", "realpathSync", "readdirSync", "readFileSync"]) {
    wrap(fs, name, () => `fs:${name}`);
  }
  syncBuiltinESMExports();
  const started = performance.now();
  let output;
  try { output = build(); return output; }
  finally {
    const ms = performance.now() - started;
    for (const restore of originals.reverse()) restore();
    syncBuiltinESMExports();
    appendNativeOracleTiming({ kind: "native-build", label, ms, load: loadavg(),
      completed: typeof output === "string",
      sealed: typeof output === "string" && fs.existsSync(`${output}.build.json`),
      lockRemaining: typeof output === "string" && fs.existsSync(`${output}.build-lock`),
      phases: Object.fromEntries(totals), inspections, inspectionsOmitted });
  }
}
