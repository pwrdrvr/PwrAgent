// Self-test for the suite-wide guard in `setup/agent-cli-spawn-guard.ts`.
//
// The guard is loaded as a `desktop-main` setup file, so it is already active
// here. These tests deliberately trip it and then drain its violation record
// before the guard's own `afterEach` reads it — otherwise the deliberate
// violation would fail the test that caused it on purpose.
import { execFile as execFileCallback } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

const VIOLATIONS = Symbol.for("pwragent.agentCliSpawnGuard.violations");

const tempDirs: string[] = [];

// Extensionless shebang files are not executable through execFile on Windows,
// the same constraint `acp-runtime-override-launch.test.ts` documents.
const describeGuard = process.platform === "win32" ? describe.skip : describe;

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describeGuard("agent CLI spawn guard", () => {
  it("allows a fixture agent executable inside the temp dir", async () => {
    const tempDir = makeTempDir();
    const command = path.join(tempDir, "kimi");
    writeFileSync(command, "#!/bin/sh\necho fixture\n", "utf8");
    chmodSync(command, 0o755);

    const result = await execFile(command, []);

    expect(result.stdout.trim()).toBe("fixture");
    expect(drainViolations()).toEqual([]);
  });

  it("blocks a temp-dir symlink that resolves outside the temp dir", async () => {
    // The shape that matters in this domain: `~/.local/bin/grok` is a symlink
    // to `~/.grok/bin/grok`, so checking the literal path alone would let a
    // real installation through on a fixture-looking name.
    const tempDir = makeTempDir();
    const command = path.join(tempDir, "grok");
    symlinkSync(process.execPath, command);

    const error = await captureSpawnError(() => execFile(command, ["--version"]));

    expect(error.message).toContain(command);
    expect(drainViolations().map((violation) => violation.file)).toEqual([
      command,
    ]);
  });

  it("blocks a bare agent command name resolved against the child PATH", async () => {
    const error = await captureSpawnError(() => execFile("qwen", ["--version"]));

    expect(error.message).toContain("qwen");
    expect(drainViolations().map((violation) => violation.file)).toEqual([
      "qwen",
    ]);
  });

  it("ignores executables that are not agent CLIs", async () => {
    const result = await execFile("/bin/echo", ["ok"]);

    expect(result.stdout.trim()).toBe("ok");
    expect(drainViolations()).toEqual([]);
  });
});

/**
 * The guard throws from inside `ChildProcess.prototype.spawn`. `execFile` has a
 * custom promisifier that calls through OUTSIDE the promise executor, so that
 * throw arrives synchronously rather than as a rejection — `.rejects` would
 * never see it. An `async` caller's own `try`/`catch` still swallows it either
 * way, which is why the guard records the violation instead of relying on it.
 */
async function captureSpawnError(
  spawn: () => Promise<unknown>,
): Promise<Error> {
  try {
    await spawn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the guard to block this spawn");
}

/** Consumes the guard's record so its own `afterEach` sees a clean slate. */
function drainViolations(): { args: string[]; file: string }[] {
  const recorded = (globalThis as Record<symbol, unknown>)[VIOLATIONS] as
    | { args: string[]; file: string }[]
    | undefined;
  return recorded?.splice(0) ?? [];
}

function makeTempDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-spawn-guard-"));
  tempDirs.push(tempDir);
  return tempDir;
}
