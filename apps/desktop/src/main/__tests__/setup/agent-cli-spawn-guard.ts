// Fails any test that spawns a real coding-agent CLI from the machine running
// the suite.
//
// Agent discovery probes far more than `env.PATH`: the ACP kit also scans
// well-known `$HOME` bin dirs and each strategy's absolute fallback candidates
// (`~/.kimi-code/bin/kimi`, `/opt/homebrew/bin/qwen`, …), and Codex discovery
// probes its own install locations. A test that sandboxes only `PATH` still
// `execFile`s whatever the developer happens to have installed — hundreds of
// short-lived `kimi` / `grok` / `qwen` / `codex` processes per run — and then
// asserts against those versions instead of its fixtures. CI hides all of it,
// because CI machines have none of those binaries: the probe fails, discovery
// finds nothing, and the assertions still pass. This guard makes the local
// behavior and the CI behavior the same failure.
//
// The hook is `ChildProcess.prototype.spawn` rather than the `child_process`
// exports because it is the one chokepoint every async spawn path funnels
// through (`exec`, `execFile`, `spawn` all reach it), and because a prototype
// patch survives however a module imported `child_process` — including
// externally bundled dependencies that vitest never transforms and `vi.mock`
// therefore cannot reach.
//
// Fix a failure by injecting the seam, never by widening `ALLOWED_ROOTS`:
//   - ACP discovery: pass `listExecutables` + `fallbackRootDir` (and
//     `bundledGrokCommand: null`) so candidates stay inside the fixture, or
//     inject `discover` / `readVersionOutput` outright.
//   - Codex discovery: inject `codexDiscoveryCoordinator`, or stub
//     `discoverCodexCommands` from `@pwrdrvr/codex-discovery`.
//   - Everything else: `vi.mock` the discovery module, as `settings-ipc` and
//     `backend-registry` already do.
import { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach } from "vitest";
import { isPathWithin } from "../../../shared/path-within";

/** `codex`, `kimi-code`, `grok-absolute-override`, `codex-beta`, … */
const AGENT_CLI_PATTERN =
  /^(claude|codex|gemini|grok|kimi|qwen)(-[\w.-]+)?(\.(exe|cmd|bat))?$/i;

/**
 * Only the OS temp dir. Every fixture in this suite builds its fake agent
 * executables under `mkdtemp(os.tmpdir(), …)`, so a spawn from anywhere else
 * is by definition a binary this suite did not create. Both spellings are kept
 * because macOS reports `/var/folders/…` while its realpath is
 * `/private/var/folders/…`.
 */
const ALLOWED_ROOTS = [os.tmpdir(), realpathOrSelf(os.tmpdir())];

type SpawnOptions = { args?: string[]; file?: string };

/** `ChildProcess#spawn` is internal to Node and absent from `@types/node`. */
type SpawnableChildProcess = ChildProcess & {
  spawn: (options: SpawnOptions) => unknown;
};

type Violation = { args: string[]; file: string };

const INSTALLED = Symbol.for("pwragent.agentCliSpawnGuard.installed");
const VIOLATIONS = Symbol.for("pwragent.agentCliSpawnGuard.violations");

type GuardGlobal = typeof globalThis & {
  [INSTALLED]?: true;
  [VIOLATIONS]?: Violation[];
};

const guardGlobal = globalThis as GuardGlobal;
const violations: Violation[] = (guardGlobal[VIOLATIONS] ??= []);

// Setup files re-run for every test file in a worker, but the builtin
// prototype is shared across all of them — patch it exactly once.
if (guardGlobal[INSTALLED] !== true) {
  guardGlobal[INSTALLED] = true;
  const prototype = ChildProcess.prototype as SpawnableChildProcess;
  const original = prototype.spawn;
  prototype.spawn = function guardedSpawn(
    this: SpawnableChildProcess,
    options: SpawnOptions,
  ) {
    const file = options?.file ?? "";
    if (isForbiddenAgentCli(file)) {
      const violation: Violation = { args: options?.args ?? [], file };
      violations.push(violation);
      // Throwing stops the real process from starting. It is not enough on its
      // own — discovery probes run inside try/catch and would swallow it — so
      // the recorded violation is what actually fails the test below.
      throw new Error(describeViolation(violation));
    }
    return original.call(this, options);
  };
}

afterEach(() => {
  reportRecordedViolations("This test");
});

// `afterEach` cannot see a spawn from `afterAll`, nor one from an async probe
// that settles after the final test. The recorded violation would sit in the
// array unread and the file would exit green, since the throw at the spawn site
// is swallowed by the probe's own try/catch.
afterAll(() => {
  reportRecordedViolations("This test file, after its last test,");
});

function reportRecordedViolations(subject: string): void {
  const observed = violations.splice(0);
  if (observed.length > 0) {
    throw new Error(
      [
        `${subject} spawned ${observed.length} real coding-agent CLI process(es):`,
        ...observed.map((violation) => `  ${describeViolation(violation)}`),
        "Confine discovery to the test's fixtures instead — see the remedies in",
        "apps/desktop/src/main/__tests__/setup/agent-cli-spawn-guard.ts.",
      ].join("\n"),
    );
  }
}

function isForbiddenAgentCli(file: string): boolean {
  if (file.length === 0 || !AGENT_CLI_PATTERN.test(path.basename(file))) {
    return false;
  }
  // A bare command name is resolved by the OS against the child's `PATH`, so
  // nothing here can prove it stays inside the fixture. Treat it as escaping.
  return path.isAbsolute(file) ? !isInsideAllowedRoot(file) : true;
}

/**
 * Resolved, not literal. A symlink under the temp dir pointing at a real
 * installation would otherwise pass on its raw path alone, and symlinked agent
 * CLIs are the norm here (`~/.local/bin/grok` → `~/.grok/bin/grok` → the
 * downloaded binary). `realpathOrSelf` falls back to the literal path when the
 * file does not exist, which is what the sandboxed-but-absent fallback
 * candidates (`<fixture>/.kimi-code/bin/kimi`) rely on.
 */
function isInsideAllowedRoot(file: string): boolean {
  const resolved = realpathOrSelf(file);
  return ALLOWED_ROOTS.some((root) => isPathWithin(root, resolved));
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function describeViolation(violation: Violation): string {
  return `${violation.file} ${violation.args.slice(1).join(" ")}`.trim();
}
