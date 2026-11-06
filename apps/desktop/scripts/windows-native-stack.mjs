import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

function localDirectory(directory) {
  return typeof directory === "string" && path.isAbsolute(directory)
    && !/^[\\/]{2}|[;*\r\n]/.test(directory);
}

// SymChk writes <cache>/<name>.pdb/<GUID+age>/<name>.pdb. Enumerate those
// directories explicitly: CDB rejects even a local srv* path with -netsyms:no.
export function localSymbolDirectories(cache) {
  if (!localDirectory(cache)) throw new Error("Invalid local symbol cache.");
  const directories = [cache];
  for (const pdb of readdirSync(cache, { withFileTypes: true })) {
    if (!pdb.isDirectory() || !/^[a-z0-9_.-]+\.pdb$/i.test(pdb.name)) continue;
    for (const identity of readdirSync(path.join(cache, pdb.name), { withFileTypes: true })) {
      if (!identity.isDirectory() || !/^[a-f0-9]{33,42}$/i.test(identity.name)) continue;
      const directory = path.join(cache, pdb.name, identity.name);
      try {
        if (lstatSync(path.join(directory, pdb.name)).isFile()) directories.push(directory);
      } catch { /* A partial preload is not a usable PDB. */ }
    }
  }
  return directories;
}

export function nativeStackArguments(pid, symbols, command = "~* kn 40;q") {
  const directories = Array.isArray(symbols) ? symbols : [symbols];
  if (!Number.isSafeInteger(pid) || pid <= 0 || !directories.length || !directories.every(localDirectory)) {
    throw new Error("Invalid native stack target or local symbol directories.");
  }
  // -pvr never suspends or invasively attaches to the target. Do not combine
  // it with -pd: current CDB exits before attaching (detach-on-exit unsupported).
  // Symbol downloads must happen before E2E starts.
  return ["-pvr", "-noinh", "-noshell", "-sins", "-netsyms:no",
    "-y", directories.join(";"), "-p", String(pid), "-c", command];
}

export function nativeDebuggerStatus(output) {
  return {
    detachUnsupported: /The system does not support detach on exit/i.test(output),
    networkPathDisallowed: /Network path disallowed/i.test(output),
    bannerObserved: /Microsoft \(R\) Windows Debugger/i.test(output),
    extensionInitializationStarted: /Preparing the environment for Debugger Extensions Gallery/i.test(output),
    extensionInitializationCompleted: /Waiting for Debugger Extensions Gallery to Initialize completed/i.test(output),
    commandPromptObserved: /(?:^|\n)\s*\d+:[a-f0-9]+>/i.test(output),
    readinessMarkerObserved: /pwragent-noninvasive-ready/.test(output),
    outputBytes: Buffer.byteLength(output),
  };
}

const probeReasons = new Map([
  ["Noninvasive debugger exited before readiness", "debugger-exited-before-readiness"],
  ["Noninvasive debugger readiness was not observed", "debugger-readiness-timeout"],
  ["Noninvasive debugger did not produce native frames", "debugger-no-native-frames"],
  ["Debugger suspended the controlled source", "debugger-blocked-heartbeat"],
  ["Cancelled noninvasive debugger did not close", "debugger-cancellation-timeout"],
  ["Debugger cancellation suspended the controlled source", "debugger-cancellation-blocked-heartbeat"],
  ["Noninvasive debugger quit did not close", "debugger-quit-timeout"],
  ["Noninvasive debugger quit failed", "debugger-quit-failed"],
  ["Debugger quit stopped the controlled source", "debugger-quit-blocked-heartbeat"],
]);
export function nativeProbeFailure(error) {
  // Never persist an exception message or raw debugger output: either can
  // include private paths, command arguments and register contents.
  return {
    reason: probeReasons.get(error?.message) ?? "controlled-probe-failed",
    triageGuide: "docs/playwright-worker-shutdown-diagnostics.md#controlled-native-debugger-setup-failures",
    debugger: error?.nativeDebugger && {
      exitCode: Number.isSafeInteger(error.nativeDebugger.exitCode) ? error.nativeDebugger.exitCode : undefined,
      detachUnsupported: error.nativeDebugger.detachUnsupported === true,
      networkPathDisallowed: error.nativeDebugger.networkPathDisallowed === true,
      bannerObserved: error.nativeDebugger.bannerObserved === true,
      extensionInitializationStarted: error.nativeDebugger.extensionInitializationStarted === true,
      extensionInitializationCompleted: error.nativeDebugger.extensionInitializationCompleted === true,
      commandPromptObserved: error.nativeDebugger.commandPromptObserved === true,
      readinessMarkerObserved: error.nativeDebugger.readinessMarkerObserved === true,
      outputBytes: Number.isSafeInteger(error.nativeDebugger.outputBytes) ? error.nativeDebugger.outputBytes : undefined,
    },
  };
}

export function verifiedNativeStack(before, after, expectedCreated, stack) {
  return before?.verified === true && before.liveAfter === true
    && after?.verified === true && after.liveAfter === true
    && before.pid === after.pid && before.created === expectedCreated && after.created === expectedCreated
    && stack.threads.length > 0 && stack.threads.every((thread) => parseInt(thread.pid, 16) === before.pid);
}

// CDB output includes local paths, arguments and addresses. Keep only bounded
// thread identities and call-site symbols; never persist its raw output.
export function parseNativeStacks(output, { moduleOffsets = false } = {}) {
  const lines = output.split(/\r?\n/);
  const modules = [];
  const address = (value) => {
    const hex = value.replaceAll("`", "");
    return /^[a-f0-9]{1,16}$/i.test(hex) ? BigInt("0x" + hex) : undefined;
  };
  if (moduleOffsets) {
    for (const line of lines) {
      const module = /^\s*([a-f0-9`]{8,17})\s+([a-f0-9`]{8,17})\s+([a-z0-9_.-]{1,128})\s+\(/i.exec(line);
      if (!module || modules.length >= 512) continue;
      const start = address(module[1]);
      const end = address(module[2]);
      if (start !== undefined && end !== undefined && start < end) modules.push({ start, end, name: module[3] });
    }
  }
  const threads = [];
  let current, previousReturn, previousIndex;
  let omittedThreads = 0, omittedFrames = 0, symbolWarnings = 0;
  for (const line of lines) {
    if (/\*\*\* (?:ERROR|WARNING):.*(?:symbol|timestamp)/i.test(line)) symbolWarnings++;
    const thread = /^\s*[.#]?\s*(\d+)\s+Id:\s*([a-f0-9]+)\.([a-f0-9]+)\b/i.exec(line);
    if (thread) {
      current = undefined;
      previousReturn = undefined;
      previousIndex = undefined;
      if (threads.length >= 128) { omittedThreads++; continue; }
      current = { index: Number(thread[1]), pid: thread[2].toLowerCase(), tid: thread[3].toLowerCase(), frames: [] };
      threads.push(current);
      continue;
    }
    const frame = /^\s*([a-f0-9]{2,3})\s+[a-f0-9`]+\s+([a-f0-9`]{1,17})\s+(\S+)/i.exec(line);
    if (!frame || !current) continue;
    const index = parseInt(frame[1], 16);
    // A stack row's return address is the next row's code location. Convert
    // it against lm's image bounds in memory; never retain virtual addresses.
    const code = index === previousIndex + 1 ? previousReturn : undefined;
    previousReturn = address(frame[2]);
    previousIndex = index;
    const module = moduleOffsets && code !== undefined
      ? modules.find((image) => code >= image.start && code < image.end) : undefined;
    const symbol = module ? `${module.name}+0x${(code - module.start).toString(16)}` : frame[3];
    // Accept module!symbol or module+offset. No paths, arguments or raw memory.
    if (!/^[a-z0-9_.-]+(?:![a-z0-9_.$~?@:+<>,*&()={}\[\]`'-]+|\+0x[a-f0-9]+)$/i.test(symbol)
      || current.frames.length >= 40) { omittedFrames++; continue; }
    current.frames.push({ index, symbol });
  }
  return { threads, omittedThreads, omittedFrames, symbolWarnings,
    frameCount: threads.reduce((count, thread) => count + thread.frames.length, 0) };
}
