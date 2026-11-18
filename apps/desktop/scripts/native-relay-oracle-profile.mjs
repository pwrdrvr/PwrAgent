// Test-only, opt-in diagnostics. Never imported by the production builder.
import childProcess from "node:child_process";
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
  const originals = [];
  const wrap = (object, name, classify) => {
    const original = object[name];
    const observed = function(...args) {
      const key = classify(...args);
      const started = performance.now();
      try { return Reflect.apply(original, this, args); }
      finally {
        const entry = totals.get(key) ?? { count: 0, ms: 0 };
        entry.count++;
        entry.ms += performance.now() - started;
        totals.set(key, entry);
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
  });
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
      phases: Object.fromEntries(totals) });
  }
}
