import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import path from "node:path";

export const GIB = 1024 ** 3;
export const LOW_MEMORY_THRESHOLD = 16 * GIB;
export const LOW_MEMORY_HEAP_MIB = 2048;
export const TYPECHECK_HEAP_MIB = 4096;

function readOptional(file, readFile) {
  try {
    return readFile(file, "utf8").trim();
  } catch {
    return "";
  }
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

// Read capacity, never free/available memory. A leaf can be unlimited while
// its pod or user slice imposes a finite limit, so visit every visible ancestor.
export function readCgroupMemoryLimits(readFile = readFileSync, platform = process.platform) {
  if (platform !== "linux") return [];
  const memberships = readOptional("/proc/self/cgroup", readFile).split("\n");
  const mounts = readOptional("/proc/self/mountinfo", readFile).split("\n");
  const limits = [];
  for (const mount of mounts) {
    const [left, right] = mount.split(" - ");
    if (!right) continue;
    const fields = left.split(" ");
    const [type, , options] = right.split(" ");
    const v2 = type === "cgroup2";
    if (!v2 && !(type === "cgroup" && options?.split(",").includes("memory"))) continue;
    const membership = memberships.find((line) => {
      const [, controllers] = line.split(":");
      return v2 ? controllers === "" : controllers?.split(",").includes("memory");
    });
    if (!membership) continue;
    const memberPath = membership.slice(membership.indexOf(":", membership.indexOf(":") + 1) + 1);
    const mountRoot = decodeMountPath(fields[3]);
    const mountPoint = decodeMountPath(fields[4]);
    let relative;
    if (memberPath === "/") relative = ".";
    else if (mountRoot === "/" || memberPath === mountRoot || memberPath.startsWith(`${mountRoot}/`)) {
      relative = path.posix.relative(mountRoot, memberPath);
    } else continue;
    let directory = path.posix.resolve(mountPoint, relative);
    while (directory === mountPoint || directory.startsWith(`${mountPoint}/`)) {
      const raw = readOptional(path.posix.join(directory, v2 ? "memory.max" : "memory.limit_in_bytes"), readFile);
      const value = Number(raw);
      if (raw !== "" && Number.isFinite(value) && value >= 0) limits.push(value);
      if (directory === mountPoint) break;
      directory = path.posix.dirname(directory);
    }
  }
  return limits;
}

export function getToolResourcePolicy({
  hostMemory = totalmem(),
  constrainedMemory = process.constrainedMemory?.() ?? 0,
  cgroupLimits = readCgroupMemoryLimits(),
} = {}) {
  // constrainedMemory() uses zero to mean unknown; a cgroup's literal zero
  // is a real hard limit and must never make a large host look unconstrained.
  const finiteLimits = [
    ...[hostMemory, constrainedMemory].filter((value) => Number.isFinite(value) && value > 0),
    ...cgroupLimits.filter((value) => Number.isFinite(value) && value >= 0),
  ];
  const effectiveMemory = Math.min(...finiteLimits);
  return { hostMemory, effectiveMemory, constrained: effectiveMemory < LOW_MEMORY_THRESHOLD };
}

const NODE_VALUE_OPTIONS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "-C", "--conditions", "--title", "--inspect-port", "--inspect-publish-uid",
  "--env-file", "--env-file-if-exists", "--input-type",
  "--redirect-warnings", "--diagnostic-dir", "--heap-snapshot-signal",
  "--heapsnapshot-signal", "--cpu-prof-dir", "--cpu-prof-name",
  "--cpu-prof-interval", "--heap-prof-dir", "--heap-prof-name",
  "--heap-prof-interval", "--trace-event-categories", "--trace-event-file-pattern",
  "--experimental-policy", "--policy-integrity", "--openssl-config",
  "--icu-data-dir", "--use-largepages", "--unhandled-rejections",
]);
const HEAP_OPTION = /^--max[-_]old[-_]space[-_]size(?:[-_]percentage)?(?:=|$)/;

function withoutHeapOptions(tokens) {
  const retained = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^"|"$/g, "");
    if (HEAP_OPTION.test(token)) {
      if (!token.includes("=")) index += 1;
    } else retained.push(tokens[index]);
  }
  return retained;
}

export function toolHeapMiB(command, args, cwd = process.cwd()) {
  const name = path.basename(command).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  // Full desktop type checking and its typed ESLint program exceed 2 GiB.
  // Preserve their semantic coverage with one serial program, at 4 GiB.
  const projectIndex = args.findIndex((arg) => arg === "-p" || arg === "--project");
  const project = args.find((arg) => arg.startsWith("--project="))?.slice("--project=".length)
    ?? (projectIndex >= 0 ? args[projectIndex + 1] : "tsconfig.json")
    ?? "tsconfig.json";
  const fullDesktopProgram = name === "tsc"
    && path.resolve(cwd, project) === path.resolve(import.meta.dirname, "../apps/desktop/tsconfig.json");
  const configIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
  const lintConfig = args.find((arg) => arg.startsWith("--config="))?.slice("--config=".length)
    ?? (configIndex >= 0 ? args[configIndex + 1] : "")
    ?? "";
  return fullDesktopProgram || (name === "eslint" && path.basename(lintConfig) === "eslint.typed.config.mjs")
    ? TYPECHECK_HEAP_MIB : LOW_MEMORY_HEAP_MIB;
}

export function cappedNodeOptions(options = "", heapMiB = LOW_MEMORY_HEAP_MIB) {
  const tokens = options.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) ?? [];
  return [...withoutHeapOptions(tokens), `--max-old-space-size=${heapMiB}`].join(" ");
}

export function resourceEnvironment(command, args, env, policy, cwd = process.cwd()) {
  if (!policy.constrained) return env;
  let options = env.NODE_OPTIONS ?? "";
  const name = path.basename(command).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (name === "pnpm") {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--node-options") options += ` ${args[++index] ?? ""}`;
      else if (arg.startsWith("--node-options=")) options += ` ${arg.slice("--node-options=".length)}`;
    }
  }
  return { ...env, NODE_OPTIONS: cappedNodeOptions(options, toolHeapMiB(command, args, cwd)) };
}

function replaceOption(args, names, replacement, prepend = false) {
  const retained = [];
  for (let index = 0; index < args.length; index += 1) {
    if (names.some((name) => args[index] === name || args[index].startsWith(`${name}=`))) {
      if (!args[index].includes("=")) index += 1;
    } else retained.push(args[index]);
  }
  return prepend ? [replacement, ...retained] : [...retained, replacement];
}

function withoutBooleanOptions(args, names) {
  const retained = [];
  for (let index = 0; index < args.length; index += 1) {
    if (names.some((name) => args[index] === name || args[index].startsWith(`${name}=`))) {
      if (!args[index].includes("=") && ["true", "false"].includes(args[index + 1])) index += 1;
    } else retained.push(args[index]);
  }
  return retained;
}

export function resourceCommand(command, args, policy) {
  if (!policy.constrained) return args;
  const name = path.basename(command).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (name === "node") {
    // CLI V8 flags take precedence over NODE_OPTIONS. Only rewrite Node's
    // option prefix; flags passed to a script are application arguments.
    let end = 0;
    while (end < args.length && args[end].startsWith("-")) {
      const arg = args[end++];
      if (arg === "--" || /^(?:-e|-p|--eval|--print)(?:=|$)/.test(arg)) break;
      if (HEAP_OPTION.test(arg) && !arg.includes("=")) end += 1;
      else if (NODE_VALUE_OPTIONS.has(arg)) end += 1;
    }
    return [`--max-old-space-size=${toolHeapMiB(command, args)}`, ...withoutHeapOptions(args.slice(0, end)), ...args.slice(end)];
  }
  if (name === "pnpm") {
    // pnpm 12's native CLI rejects --node-options. Consume it in the
    // environment policy on small machines; preserve original argv on large.
    const retained = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--node-options") index += 1;
      else if (!args[index].startsWith("--node-options=")) retained.push(args[index]);
    }
    return args.includes("-r") || args.includes("--recursive") || args[0] === "recursive"
      ? replaceOption(withoutBooleanOptions(retained, ["--parallel"]), ["--workspace-concurrency"], "--workspace-concurrency=1", true) : retained;
  }
  if (name === "vitest") {
    const workers = replaceOption(args, ["--maxWorkers", "--max-workers", "--minWorkers", "--min-workers"], "--maxWorkers=1");
    const concurrency = replaceOption(workers, ["--maxConcurrency", "--max-concurrency"], "--maxConcurrency=1");
    return [...withoutBooleanOptions(concurrency, ["--fileParallelism", "--file-parallelism", "--no-file-parallelism"]), "--no-file-parallelism"];
  }
  if (name === "playwright" && args[0] === "test") return replaceOption(args, ["--workers", "-j"], "--workers=1");
  return args;
}
