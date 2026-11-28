import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCodexVersionCore } from "@pwragent/shared/codex-version";
import {
  CODEX_USER_UPDATE_ACTIVE_PHASES,
  type CodexUpdateTarget,
  type CodexUserUpdateState,
} from "../../shared/codex-user-update";
import { CodexUserUpdateService, type SpawnCodexUpdate } from "../codex-user-update";

/**
 * A model of the stock Codex update service driven through its real entry
 * points: window reads, Update presses (several windows can press at once),
 * npm answers that can be deferred or fail, installers that exit, fail, change
 * nothing, or hang, rediscovery that can select another Codex, the operator
 * updating Codex outside PwrAgent, and time passing.
 *
 * Promises checked after every step, from the PR and the service's comments:
 * - one installer at a time;
 * - an installer runs only for a recognized install behind the latest release;
 * - "succeeded" and a Codex restart only when the same command moved forward;
 * - a run leaves "updating" once its installer exits, or times out;
 * - every subscribed window sees the offer a fresh read returns;
 * - the background check never stops scheduling itself.
 */

const BREW = "/opt/homebrew/bin/codex";
const OTHER = "/usr/local/bin/codex";
const VERSIONS = ["0.171.0", "0.172.0", "0.173.0", "0.174.0"] as const;
type Version = (typeof VERSIONS)[number];
type InstallKind = "homebrew" | "unknown" | "pwragent-openai";

type Command =
  | { kind: "read" }
  | { kind: "answer"; latest: Version | "deferred" | "error" }
  | { kind: "press"; presses: 1 | 2 }
  | { kind: "exit"; code: 0 | 1; installs: Version | "same"; switchesCommand: boolean }
  | { kind: "externalUpdate"; version: Version }
  | { kind: "advance"; ms: number };

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "read" as const }) },
  { weight: 3, arbitrary: fc.record({
    kind: fc.constant("answer" as const),
    latest: fc.constantFrom<Version | "deferred" | "error">(...VERSIONS, "deferred", "error"),
  }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("press" as const), presses: fc.constantFrom<1 | 2>(1, 2) }) },
  { weight: 3, arbitrary: fc.record({
    kind: fc.constant("exit" as const),
    code: fc.constantFrom<0 | 1>(0, 0, 1),
    installs: fc.constantFrom<Version | "same">(...VERSIONS, "same"),
    switchesCommand: fc.boolean(),
  }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("externalUpdate" as const), version: fc.constantFrom(...VERSIONS) }) },
  { weight: 2, arbitrary: fc.record({
    kind: fc.constant("advance" as const),
    ms: fc.constantFrom(1_000, 3_000, 6_000, 16 * 60_000, 6 * 60 * 60_000 + 1),
  }) },
);

type Scenario = {
  install: InstallKind;
  initial: Version;
  /** The installer (or something it started) keeps running after SIGTERM. */
  ignoresTerm: boolean;
  /** Homebrew's `brew` is where the Caskroom says it is. */
  brewFound: boolean;
  commands: Command[];
};
const scenario: fc.Arbitrary<Scenario> = fc.record({
  install: fc.constantFrom<InstallKind>("homebrew", "homebrew", "unknown", "pwragent-openai"),
  initial: fc.constantFrom(...VERSIONS),
  ignoresTerm: fc.boolean(),
  brewFound: fc.boolean(),
  commands: fc.array(command, { minLength: 1, maxLength: 30, size: "max" }),
});

function below(a: string | undefined, b: string | undefined): boolean {
  const x = parseCodexVersionCore(a);
  const y = parseCodexVersionCore(b);
  if (!x || !y) return false;
  for (let index = 0; index < 3; index += 1) {
    if (x[index] !== y[index]) return x[index]! < y[index]!;
  }
  return false;
}

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

type FakeChild = ChildProcess & { finished: boolean };

async function replay({ install, initial, ignoresTerm, brewFound, commands }: Scenario): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const initialCommand = install === "unknown" ? "/opt/tools/codex" : BREW;
  let target: CodexUpdateTarget = {
    command: initialCommand,
    version: initial,
    managedByPwrAgent: false,
    ...(install === "pwragent-openai" ? { openAiInstalledByPwrAgent: true } : {}),
  };
  // What the installer leaves on disk, which rediscovery reads.
  let disk: { command: string; version: Version | string } = { command: target.command, version: initial };
  let pendingSwitch = false;
  let lastAnswer: Version | undefined;
  const fetches: Array<(value: string | undefined) => void> = [];
  const fetchFailures: Array<(error: Error) => void> = [];
  const children: FakeChild[] = [];
  let maxConcurrent = 0;
  let restarts = 0;
  const published: CodexUserUpdateState[] = [];

  const spawn: SpawnCodexUpdate = () => {
    const child = new EventEmitter() as FakeChild;
    const stream = (): EventEmitter & { destroy: () => void } =>
      Object.assign(new EventEmitter(), { destroy: () => undefined });
    // SIGKILL always ends it; SIGTERM only when the scenario says so.
    const kill = (signal?: NodeJS.Signals): boolean => {
      if (child.finished || (ignoresTerm && signal !== "SIGKILL")) return true;
      child.finished = true;
      setTimeout(() => {
        child.emit("exit", null, signal ?? "SIGTERM");
        child.emit("close", null, signal ?? "SIGTERM");
      }, 0);
      return true;
    };
    Object.assign(child, { stdout: stream(), stderr: stream(), kill, finished: false });
    children.push(child);
    // Promise: an installer starts only for a recognized install that is behind.
    expect({
      install,
      brewFound,
      behind: lastAnswer !== undefined && below(target.version, lastAnswer),
    }).toEqual({ install: "homebrew", brewFound: true, behind: true });
    const running = children.filter((entry) => !entry.finished).length;
    maxConcurrent = Math.max(maxConcurrent, running);
    return child;
  };

  const service = new CodexUserUpdateService({
    readTarget: async () => target,
    resolvePath: async (cmd) => (cmd === BREW ? `/opt/homebrew/Caskroom/codex/${target.version}/codex` : cmd),
    resolveEnv: async () => ({}),
    fetchLatestVersion: () => new Promise<string | undefined>((resolve, reject) => {
      fetches.push(resolve);
      fetchFailures.push(reject);
    }),
    rediscover: async () => {
      target = { ...target, command: disk.command, version: disk.version };
      if (pendingSwitch) {
        target = { command: OTHER, version: "0.174.0", managedByPwrAgent: false };
      }
    },
    restartCodex: async () => {
      restarts += 1;
    },
    isExecutable: async () => brewFound,
    resolveOnPath: async () => undefined,
    platform: "darwin",
    spawn,
    timeoutMs: 15 * 60_000,
  });
  service.subscribe((state) => published.push(state));

  const succeededRuns = new Set<number>();
  let lastRunPhase: { id: number; phase: string } | undefined;
  let everRead = false;
  let exitedAt: number | undefined;

  const check = async (label: string) => {
    await flush();
    const state = service.snapshot();
    const run = state.run;
    // One installer at a time, including one a timed-out run left behind.
    expect({ label, concurrentInstallers: maxConcurrent > 1 }).toEqual({ label, concurrentInstallers: false });
    // Phases only move forward within a run.
    if (run && lastRunPhase?.id === run.id) {
      const order = ["updating", "verifying", "restarting", "succeeded"];
      const before = order.indexOf(lastRunPhase.phase);
      const after = order.indexOf(run.phase);
      if (before >= 0 && after >= 0) expect({ label, back: after < before }).toEqual({ label, back: false });
      if (!CODEX_USER_UPDATE_ACTIVE_PHASES.has(lastRunPhase.phase as never)) {
        expect({ label, phase: run.phase }).toEqual({ label, phase: lastRunPhase.phase });
      }
    }
    if (run) lastRunPhase = { id: run.id, phase: run.phase };
    // Credit only a real update of the same command, and restart only then.
    if (run?.phase === "succeeded") {
      succeededRuns.add(run.id);
      expect({
        label,
        sameCommand: target.command === initialCommand,
        moved: below(run.fromVersion, run.toVersion),
      }).toEqual({ label, sameCommand: true, moved: true });
    }
    expect({ label, restarts }).toEqual({ label, restarts: succeededRuns.size });
    // No run stays "updating" once its installer is gone for longer than the drain grace.
    if (run?.phase === "updating" && exitedAt !== undefined && children.every((child) => child.finished)) {
      expect({ label, stuck: Date.now() - exitedAt > 5_000 }).toEqual({ label, stuck: false });
    }
    if (everRead) {
      // The background check never stops: a fetch is waiting or a timer is set.
      expect({ label, alive: fetches.length > 0 || vi.getTimerCount() > 0 }).toEqual({ label, alive: true });
      // Every subscribed window sees the offer a fresh read returns.
      const fresh = await service.readState();
      await flush();
      const lastPublished = published.at(-1);
      if (lastPublished !== undefined || fresh.offer !== undefined) {
        expect({ label, windows: lastPublished?.offer ?? null }).toEqual({ label, windows: fresh.offer ?? null });
      }
    }
  };

  try {
    for (const [step, cmd] of commands.entries()) {
      const label = `${step}: ${JSON.stringify(cmd)}`;
      switch (cmd.kind) {
        case "read":
          everRead = true;
          await service.readState();
          break;
        case "answer": {
          const resolve = fetches.shift();
          const reject = fetchFailures.shift();
          if (!resolve || !reject) continue;
          if (cmd.latest === "error") reject(new Error("registry unreachable"));
          else if (cmd.latest === "deferred") resolve(undefined);
          else {
            lastAnswer = cmd.latest;
            resolve(cmd.latest);
          }
          break;
        }
        case "press":
          for (let press = 0; press < cmd.presses; press += 1) {
            void service.startUpdate().catch(() => undefined);
          }
          break;
        case "exit": {
          const child = children.find((entry) => !entry.finished);
          if (!child) continue;
          child.finished = true;
          if (cmd.code === 0 && cmd.installs !== "same") disk = { ...disk, version: cmd.installs };
          pendingSwitch = cmd.code === 0 && cmd.switchesCommand;
          exitedAt = Date.now();
          child.emit("exit", cmd.code, null);
          child.emit("close", cmd.code, null);
          break;
        }
        case "externalUpdate":
          disk = { ...disk, version: cmd.version };
          target = { ...target, version: cmd.version };
          break;
        case "advance":
          await vi.advanceTimersByTimeAsync(cmd.ms);
          break;
      }
      await check(label);
    }
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex update service model", () => {
  // Found by this model: a window's read recomputed the offer after Codex
  // changed outside PwrAgent, but only that window learned of it.
  it("tells every window when one window's read changes the offer", async () => {
    await replay({
      install: "homebrew",
      initial: "0.174.0",
      ignoresTerm: false,
      brewFound: true,
      commands: [
        { kind: "read" },
        { kind: "answer", latest: "0.174.0" },
        { kind: "externalUpdate", version: "0.171.0" },
      ],
    });
  });

  // Found by this model: a timeout sent one SIGTERM to the direct child and
  // ended the run after 5 s, so an installer that kept going (or the piped
  // `sh` the standalone installer starts) ran beside the next Update.
  it("stops a timed-out installer before Update can start another", async () => {
    await replay({
      install: "homebrew",
      initial: "0.171.0",
      ignoresTerm: true,
      brewFound: true,
      commands: [
        { kind: "read" },
        { kind: "answer", latest: "0.174.0" },
        { kind: "press", presses: 1 },
        { kind: "advance", ms: 6 * 60 * 60_000 + 1 },
        { kind: "press", presses: 1 },
        { kind: "read" },
      ],
    });
  });

  it("keeps its promises across reads, presses, installers, and time", async () => {
    await fc.assert(fc.asyncProperty(scenario, replay), {
      numRuns: Number(process.env.MBT_RUNS ?? 5),
    });
  });
});
