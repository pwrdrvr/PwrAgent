import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getCallSites } from "node:util";

export const E2E_CHILD_PROCESS_DIAGNOSTICS_FILE_ENV =
  "PWRAGENT_E2E_CHILD_PROCESS_DIAGNOSTICS_FILE";

type ChildCallSite = {
  functionName: string;
  scriptName: string;
  lineNumber: number;
  columnNumber: number;
};
type ChildProcessStage = "shutdown-started" | "shutdown-completed" | "will-quit" | "process-exit";

export function childProcessCallSites(sites: readonly ChildCallSite[]) {
  return sites.flatMap((site) => {
    const script = site.scriptName.replaceAll("\\", "/");
    const match = /\/(apps\/desktop\/src\/main\/[A-Za-z0-9_./-]+\.ts|out\/main\/[A-Za-z0-9_./-]+\.js)$/.exec(script);
    if (!match || match[1].includes("..")) return [];
    return [{
      functionName: site.functionName.replace(/[^A-Za-z0-9_.$<> ]/g, "?").slice(0, 120),
      file: match[1],
      line: site.lineNumber,
      column: site.columnNumber,
    }];
  }).slice(0, 8);
}

/** Opt-in, bounded launch call sites, without arguments, environment or output. */
export function installE2eChildProcessDiagnostics(options: {
  enabled: boolean;
  filePath?: string;
  launchId?: string;
  writeLine?: (line: string) => void;
}) {
  const disabled = { snapshot: (_stage: ChildProcessStage) => {}, dispose: () => {} };
  if (!options.enabled || !/^[A-Za-z0-9_-]{1,128}$/.test(options.launchId ?? "")) return disabled;
  const filePath = options.filePath;
  const writeLine = options.writeLine ?? (filePath ? (line: string) => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, line, "utf8");
  } : undefined);
  if (!writeLine) return disabled;
  let sequence = 0;
  let omitted = 0;
  const active = new Map<number, { child: ChildProcess; removeListeners: () => void }>();
  const write = (event: string, fields: object) => {
    try {
      writeLine(JSON.stringify({
        schemaVersion: 1, kind: "main-child", event,
        launchId: options.launchId, ownerPid: process.pid, at: Date.now(), ...fields,
      }) + "\n");
    } catch {
      // Observations must not interfere with the operation they describe.
    }
  };
  const spawned = channel("child_process");
  const onSpawn = (message: unknown) => {
    try {
      const child = (message as { process?: unknown })?.process;
      if (!(child instanceof ChildProcess)) return;
      if (sequence >= 128) { omitted++; return; }
      const childId = ++sequence;
      // The constructor channel runs before Node assigns child.pid. Capture
      // the caller now and join its ID to the subsequent spawn event's PID.
      const identity = () => ({ childId, pid: child.pid ?? null });
      const onStarted = () => {
        const name = path.win32.basename(child.spawnfile).toLowerCase();
        const executable = /^(gh|glab|git|git-lfs|powershell|pwsh|cmd|csc|conhost|node|electron|codex|claude)(\.exe)?$/.test(name)
          ? name : "other";
        write("spawn", { ...identity(), executable });
      };
      const onExit = () => write("exit", identity());
      const onClose = () => {
        write("close", identity());
        active.delete(childId);
      };
      active.set(childId, { child, removeListeners: () => {
        child.removeListener("spawn", onStarted);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
      } });
      child.once("spawn", onStarted);
      child.once("exit", onExit);
      child.once("close", onClose);
      write("launch", { childId,
        callSites: childProcessCallSites(getCallSites(32)) });
    } catch {
      // The diagnostic channel must never throw into child_process.spawn().
    }
  };
  spawned.subscribe(onSpawn);
  write("installed", {});
  return {
    snapshot: (stage: ChildProcessStage) => write("snapshot", {
      stage, omitted,
      children: [...active].map(([childId, { child }]) => ({ childId, pid: child.pid ?? null })),
    }),
    dispose: () => {
      spawned.unsubscribe(onSpawn);
      for (const { removeListeners } of active.values()) removeListeners();
      active.clear();
    },
  };
}
