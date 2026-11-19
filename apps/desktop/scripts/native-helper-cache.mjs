// SPDX-License-Identifier: MIT
// Local build reuse, not an authenticity boundary against the checkout owner.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { release, version } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cacheScript = fileURLToPath(import.meta.url);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const path = resolve(directory || ".", name);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch { /* Continue PATH lookup. */ }
  }
  throw new Error(`Native helper compiler is unavailable: ${name}`);
}

function snapshot(path) {
  try {
    const link = lstatSync(path, { bigint: true });
    const target = statSync(path, { bigint: true });
    const identity = (s) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String);
    return { path, real: realpathSync(path), link: identity(link), target: identity(target),
      ...(target.isDirectory() ? { entries: hash(JSON.stringify(readdirSync(path).sort())) } : {}) };
  } catch (error) {
    if (error.code === "ENOENT") return { path, missing: true };
    throw error;
  }
}

function binary(path) {
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    readSync(descriptor, bytes, 0, 4, 0);
    return ["7f454c46", "cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(bytes.toString("hex"));
  } finally { closeSync(descriptor); }
}

function tokens(line) {
  return (line.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? []).map((token) =>
    token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1) : token);
}

function plan({ args, source, output, scripts, arch }) {
  const driver = executable("cc");
  if (Object.keys(process.env).some((name) => /^(?:DYLD_|LD_(?:LIBRARY_PATH|PRELOAD|AUDIT)$)/.test(name))) return undefined;
  // Shell wrappers and arbitrary compiler frontends may have hidden inputs.
  // They keep the ordinary rebuild path, rather than receiving a partial key.
  if (!binary(driver) || !/(?:^|-)(?:cc|gcc|clang)(?:-\d+(?:\.\d+)*)?$/.test(basename(realpathSync(driver)))) return undefined;
  const trace = spawnSync("cc", ["-###", ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (trace.error || trace.status !== 0) return undefined;
  const paths = new Set([driver, "/usr/lib", "/usr/local/lib", "/lib", "/lib64", "/usr/lib64"]);
  if (process.platform === "linux") {
    for (const path of ["/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d"]) paths.add(path);
    if (existsSync("/etc/ld.so.conf.d")) {
      for (const name of readdirSync("/etc/ld.so.conf.d")) paths.add(join("/etc/ld.so.conf.d", name));
    }
  }
  const tools = new Set([realpathSync(driver)]);
  const commands = [];
  const normalized = [];
  for (const line of trace.stderr.split(/\r?\n/)) {
    if (!/^\s+(?:"\/|\/|(?:as|ld|cc1|collect2)\s)/.test(line)) { normalized.push(line); continue; }
    let command;
    try { command = tokens(line); } catch { return undefined; }
    const tool = isAbsolute(command[0]) ? command[0] : executable(command[0]);
    if (!existsSync(tool)) return undefined;
    command[0] = tool;
    tools.add(realpathSync(tool));
    paths.add(tool);
    for (let index = 1; index < command.length; index++) {
      const token = command[index];
      const value = token.slice(token.lastIndexOf("=") + 1);
      if (isAbsolute(value) && /^(?:main|identity-test|cc)[\w-]+\.(?:o|s|res)$/.test(basename(value)) && !existsSync(value)) {
        command[index] = token.replace(value, `<compiler-temporary-${value.slice(value.lastIndexOf(".") + 1)}>`);
        continue;
      }
      const path = token.startsWith("-L") ? token.slice(2) : token;
      if (isAbsolute(path) && path !== source && path !== output) {
        paths.add(path);
        if (/\.(?:so(?:\.\d+)*|dylib)$/.test(path) && existsSync(path)) tools.add(realpathSync(path));
      }
      if (["-isysroot", "-syslibroot", "--sysroot"].includes(command[index - 1]) && isAbsolute(path)) {
        for (const relative of ["usr/lib", "usr/local/lib", "System/Library/Frameworks", "SDKSettings.json", "SDKSettings.plist"]) paths.add(join(path, relative));
      }
    }
    commands.push(command);
    normalized.push(JSON.stringify(command));
  }
  if (commands.length === 0) return undefined;
  // Link-only switches cannot affect preprocessing and clang rejects some
  // of them as unused with -Werror. They remain in the full command key.
  const outputIndex = args.indexOf("-o");
  const preprocessing = args.filter((arg, index) => index !== outputIndex && index !== outputIndex + 1 && !arg.startsWith("-Wl,") && !arg.startsWith("-L") && !arg.startsWith("-l"));
  const expanded = spawnSync("cc", [...preprocessing, "-E"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  if (expanded.error || expanded.status !== 0) return undefined;
  const inputs = [...paths].sort().map(snapshot);
  const scriptBytes = scripts.map((path) => [path, existsSync(path) ? hash(readFileSync(path)) : null]);
  return { tools: [...tools], inputs, key: hash(JSON.stringify({ schema: 1, args, arch,
    platform: process.platform, kernel: [release(), version()], environment: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
    source: hash(expanded.stdout), scripts: scriptBytes, trace: normalized, inputs })) };
}

// otool -l contains dependency names, LC_ID_DYLIB and LC_RPATH together.
// Keep raw names here: @loader_path/@executable_path/@rpath belong to each
// traversal context, not to the cached inspection of an immutable file.
export function parseMachOLoadCommands(text) {
  const blocks = text.split(/^Load command \d+\r?$/m).slice(1);
  if (!blocks.length) return undefined;
  const libraries = [];
  const rpaths = [];
  const ids = [];
  const loads = new Set(["LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB", "LC_LAZY_LOAD_DYLIB"]);
  for (const block of blocks) {
    const command = /^\s+cmd (LC_\w+)\s*$/m.exec(block)?.[1];
    if (!command) return undefined;
    if (command === "LC_RPATH") {
      const value = /^\s+path (.+) \(offset \d+\)\s*$/m.exec(block)?.[1];
      if (!value) return undefined;
      rpaths.push(value);
    } else if (loads.has(command) || command === "LC_ID_DYLIB") {
      const value = /^\s+name (.+) \(offset \d+\)\s*$/m.exec(block)?.[1];
      if (!value || (loads.has(command) && !/^(?:\/|@)/.test(value))) return undefined;
      (command === "LC_ID_DYLIB" ? ids : libraries).push(value);
    } else if (command.endsWith("DYLIB")) {
      // Unknown/legacy dependency forms must not produce a partial reuse key.
      return undefined;
    }
  }
  return { libraries, rpaths, ids };
}

function dependencies(tools, trace) {
  const paths = new Set();
  for (const line of trace.split(/\r?\n/)) {
    const path = line.trim().replace(/\([^)]*\)$/, "");
    if (isAbsolute(path) && existsSync(path) && statSync(path).isFile()) paths.add(path);
  }
  // A dependency trace must identify persistent linker inputs. Otherwise the
  // build still succeeds, but it is deliberately not eligible for reuse.
  if (paths.size === 0) return undefined;
  const pending = tools.map((path) => ({ path, executable: path, rpaths: [] }));
  const visited = new Set();
  const inspections = new Map();
  let sharedCacheRequired = false;
  while (pending.length) {
    const context = pending.pop();
    const tool = context.path;
    const contextKey = JSON.stringify(context);
    if (visited.has(contextKey)) continue;
    if (visited.size > 256) return undefined;
    visited.add(contextKey);
    paths.add(tool);
    let names;
    const expand = (path) => path.replace(/^@loader_path(?=\/|$)/, dirname(tool))
      .replace(/^@executable_path(?=\/|$)/, dirname(context.executable));
    let rpaths = context.rpaths;
    if (process.platform === "darwin") {
      let inspection = inspections.get(tool);
      const identity = snapshot(tool);
      if (inspection && !equal(inspection.identity, identity)) return undefined;
      if (!inspection) {
        const commands = spawnSync("/usr/bin/otool", ["-l", tool], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
        if (commands.error || commands.status !== 0 || !equal(identity, snapshot(tool))) return undefined;
        const parsed = parseMachOLoadCommands(commands.stdout);
        if (!parsed) return undefined;
        inspection = { identity, parsed };
        inspections.set(tool, inspection);
      }
      names = inspection.parsed.libraries;
      const local = inspection.parsed.rpaths.map(expand);
      if (local.some((path) => !isAbsolute(path))) return undefined;
      rpaths = [...new Set([...local, ...rpaths])];
      for (const path of rpaths) paths.add(resolve(path));
    } else {
      const result = spawnSync("ldd", [tool], { encoding: "utf8", maxBuffer: 1024 * 1024 });
      if (result.error || result.status !== 0) {
        if (/not a dynamic executable|statically linked/.test(result.stdout + result.stderr)) continue;
        return undefined;
      }
      names = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = /(?:=>\s*)?(\/\S+)\s+\(/.exec(line);
        if (match) names.push(match[1]);
        else if (/not found|@(?:rpath|loader_path|executable_path)/.test(line)) return undefined;
      }
    }
    for (const name of names) {
      let path = process.platform === "darwin" ? expand(name) : name;
      if (path.startsWith("@rpath/")) {
        const candidates = rpaths.map((directory) => resolve(directory, path.slice(7)));
        for (const candidate of candidates) paths.add(candidate);
        path = candidates.find(existsSync);
        if (!path) return undefined;
      }
      if (!isAbsolute(path)) return undefined;
      if (existsSync(path)) {
        paths.add(path);
        if (process.platform === "darwin") pending.push({ path: realpathSync(path), executable: context.executable, rpaths });
      } else if (process.platform === "darwin" && (path.startsWith("/usr/lib/") || path.startsWith("/System/Library/"))) {
        paths.add(path);
        sharedCacheRequired = true;
      }
      else return undefined;
    }
  }
  for (const [tool, inspection] of inspections) {
    if (!equal(inspection.identity, snapshot(tool))) return undefined;
  }
  if (sharedCacheRequired) {
    let found = false;
    for (const directory of ["/System/Library/dyld", "/System/Cryptexes/OS/System/Library/dyld", "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld"]) {
      paths.add(directory);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).filter((name) => name.startsWith("dyld_shared_cache"))) {
        paths.add(join(directory, name));
        found = true;
      }
    }
    if (!found) return undefined;
  }
  for (const path of [...paths]) paths.add(dirname(path));
  return [...paths].sort().map(snapshot);
}

function inspectOrRebuild(inspect) {
  try { return inspect(); } catch { return undefined; }
}

function matches(metadata, current, output) {
  try {
    if (metadata.schema !== 1 || metadata.key !== current.key || !Array.isArray(metadata.inputs) || metadata.inputs.length > 4096
      || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !lstatSync(output).isFile()) return false;
    if (!metadata.inputs.every((input) => typeof input.path === "string" && isAbsolute(input.path) && equal(snapshot(input.path), input))) return false;
    return (statSync(output).mode & 0o7777) === metadata.mode && hash(readFileSync(output)) === metadata.sha256;
  } catch { return false; }
}

export function buildCachedNativeHelper({ output, args, source, scripts, arch, reuse, destination, build }) {
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true });
  const lock = `${output}.build-lock`;
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another native helper build owns ${lock}; inspect its owner before removing a stale lock.`);
    throw error;
  }
  const owner = randomUUID();
  const metadataPath = `${output}.build.json`;
  let temporary;
  const publish = () => {
    if (!destination) return;
    const staged = join(dirname(destination), `.native-helper-${owner}`);
    try {
      copyFileSync(output, staged);
      renameSync(staged, destination);
    } finally { rmSync(staged, { force: true }); }
  };
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, owner }));
    const current = reuse ? inspectOrRebuild(() => plan({ args, source, output, scripts: [cacheScript, ...scripts], arch })) : undefined;
    if (current) {
      const metadata = inspectOrRebuild(() => JSON.parse(readFileSync(metadataPath, "utf8")));
      if (metadata && matches(metadata, current, output)) { publish(); return output; }
    }
    // Only this lock's owner can invalidate, compile or publish this output.
    // Every failure after this point leaves no previous usable helper.
    rmSync(output, { force: true });
    rmSync(metadataPath, { force: true });
    temporary = mkdtempSync(join(directory, ".native-helper-"));
    const started = BigInt(Date.now()) * 1_000_000n;
    const result = build(temporary, Boolean(current));
    const inputs = current ? inspectOrRebuild(() => dependencies(current.tools, result.trace)) : undefined;
    if (current && !equal(current, inspectOrRebuild(() => plan({ args, source, output, scripts: [cacheScript, ...scripts], arch })))) {
      throw new Error("Native helper inputs changed during compilation; refusing to publish.");
    }
    const sha256 = hash(readFileSync(result.output));
    const mode = statSync(result.output).mode & 0o7777;
    renameSync(result.output, output);
    // Recently changed dependencies have no pre-build identity on the first
    // build. Publish the fresh build, but never seal ambiguous inputs for reuse.
    if (inputs && inputs.every((input) => !input.target || BigInt(input.target[5]) < started)) {
      const staged = join(temporary, "metadata.json");
      writeFileSync(staged, JSON.stringify({ schema: 1, key: current.key, inputs, sha256, mode }));
      renameSync(staged, metadataPath);
    }
    publish();
    return output;
  } catch (error) {
    rmSync(output, { force: true });
    rmSync(metadataPath, { force: true });
    if (destination) rmSync(destination, { force: true });
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    const identity = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    if (identity.owner !== owner) throw new Error(`Native helper build ownership changed: ${lock}`);
    rmSync(lock, { recursive: true });
  }
}
