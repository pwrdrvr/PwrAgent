import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUpdateTarget, CodexUserUpdateState } from "../../shared/codex-user-update";
import {
  appendOutputTail,
  CODEX_LATEST_CHECK_TTL_MS,
  CODEX_NPM_LATEST_URL,
  CodexUserUpdateService,
  fetchLatestCodexVersion,
  resolveCodexUpdateInvocation,
  runCodexUpdateProcess,
  type CodexUserUpdateServiceOptions,
  type SpawnCodexUpdate,
} from "../codex-user-update";
import { RELEASE_FIRST_CHECK_DELAY_MS } from "../github-release-cache";
import { classifyCodexInstaller } from "../settings/codex-version-advisory";

const ALL_EXECUTABLE = async (): Promise<boolean> => true;
const NOT_ON_PATH = async (): Promise<string | undefined> => undefined;

describe("resolveCodexUpdateInvocation", () => {
  const resolve = (params: {
    command: string;
    resolvedPath: string;
    platform?: NodeJS.Platform;
    executables?: string[];
    onPath?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
  }) => {
    const platform = params.platform ?? "darwin";
    return resolveCodexUpdateInvocation({
      classification: classifyCodexInstaller({
        command: params.command,
        resolvedPath: params.resolvedPath,
        platform,
      }),
      command: params.command,
      platform,
      env: params.env ?? {},
      isExecutable: async (candidate) =>
        params.executables === undefined || params.executables.includes(candidate),
      resolveOnPath: async (name) => params.onPath?.[name],
    });
  };

  it("runs the brew beside the cask it upgrades", async () => {
    await expect(resolve({
      command: "/opt/homebrew/bin/codex",
      resolvedPath: "/opt/homebrew/Caskroom/codex/0.172.0/bin/codex",
      executables: ["/opt/homebrew/bin/brew"],
    })).resolves.toEqual({
      file: "/opt/homebrew/bin/brew",
      args: ["upgrade", "--cask", "codex"],
      env: { HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_COLOR: "1", NONINTERACTIVE: "1" },
    });
  });

  it("pins npm's prefix when only another npm is on PATH", async () => {
    await expect(resolve({
      command: "/Users/x/.nvm/versions/node/v24/bin/codex",
      resolvedPath: "/Users/x/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js",
      executables: ["/usr/local/bin/npm"],
      onPath: { npm: "/usr/local/bin/npm" },
    })).resolves.toEqual({
      file: "/usr/local/bin/npm",
      args: ["install", "-g", "@openai/codex@latest"],
      env: { npm_config_prefix: "/Users/x/.nvm/versions/node/v24" },
    });
  });

  it("wraps a Windows .cmd shim in cmd.exe", async () => {
    await expect(resolve({
      command: "C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd",
      resolvedPath: "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      platform: "win32",
      executables: ["C:\\Program Files\\nodejs\\npm.cmd"],
      onPath: { npm: "C:\\Program Files\\nodejs\\npm.cmd" },
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    })).resolves.toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npm.cmd" install -g @openai/codex@latest"'],
      windowsVerbatimArguments: true,
      env: { npm_config_prefix: "C:\\Users\\x\\AppData\\Roaming\\npm" },
    });
  });

  it("re-runs OpenAI's install.sh for the install's own CODEX_HOME and bin folder", async () => {
    const invocation = await resolve({
      command: "/Users/x/.local/bin/codex",
      resolvedPath: "/Users/x/.codex/packages/standalone/releases/0.172.0-aarch64-apple-darwin/codex",
      executables: ["/bin/sh", "/usr/bin/curl"],
    });
    expect(invocation).toEqual({
      file: "/bin/sh",
      args: ["-c", expect.stringContaining('"$0" -fsSL "$1"'), "/usr/bin/curl", "https://chatgpt.com/codex/install.sh"],
      env: {
        CODEX_NON_INTERACTIVE: "1",
        CODEX_HOME: "/Users/x/.codex",
        CODEX_INSTALL_DIR: "/Users/x/.local/bin",
      },
    });
  });

  it("re-runs install.ps1 on Windows and leaves CODEX_HOME to the installer's default when the path does not name it", async () => {
    await expect(resolve({
      command: "C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      resolvedPath: "C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      executables: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
    })).resolves.toEqual({
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", "irm https://chatgpt.com/codex/install.ps1 | iex",
      ],
      env: {
        CODEX_NON_INTERACTIVE: "1",
        CODEX_HOME: undefined,
        CODEX_INSTALL_DIR: "C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin",
      },
    });
  });

  it("cannot run an update whose tool is missing", async () => {
    await expect(resolve({
      command: "/Users/x/.bun/bin/codex",
      resolvedPath: "/Users/x/.bun/install/global/node_modules/@openai/codex/bin/codex.js",
      executables: [],
    })).resolves.toBeUndefined();
  });

  it("never resolves a command for an install it does not recognize", async () => {
    await expect(resolve({
      command: "/opt/tools/codex",
      resolvedPath: "/opt/tools/codex",
    })).resolves.toBeUndefined();
  });
});

function fakeSpawn(result: { code: number | null; output?: string; error?: Error }): {
  spawn: SpawnCodexUpdate;
  calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }>;
} {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const spawn: SpawnCodexUpdate = (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, kill: () => true });
    setImmediate(() => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.output) stdout.write(result.output);
      child.emit("close", result.code, null);
    });
    return child;
  };
  return { spawn, calls };
}

describe("runCodexUpdateProcess", () => {
  it("applies the invocation's variables over the spawn environment and keeps the output tail", async () => {
    const { spawn, calls } = fakeSpawn({ code: 0, output: "upgraded codex 0.173.0\n" });
    const result = await runCodexUpdateProcess(
      { file: "/bin/brew", args: ["upgrade"], env: { CODEX_HOME: undefined, NONINTERACTIVE: "1" } },
      { env: { PATH: "/usr/bin", CODEX_HOME: "/profile/home" }, spawn },
    );
    expect(result).toEqual({ exitCode: 0, signal: null, outputTail: "upgraded codex 0.173.0\n", timedOut: false });
    expect(calls[0]?.env).toMatchObject({ PATH: "/usr/bin", NONINTERACTIVE: "1", NO_COLOR: "1" });
    expect(calls[0]?.env).not.toHaveProperty("CODEX_HOME");
  });

  it("bounds the retained output", () => {
    expect(appendOutputTail("abc", "defg", 5)).toBe("cdefg");
  });
});

describe("fetchLatestCodexVersion", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "codex-latest-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("asks npm at most once a day through the shared release budget", async () => {
    const network = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ version: "0.173.0" })));
    let now = 1_000_000;
    const read = () => fetchLatestCodexVersion({ fetch: network, directory, now: () => now });
    // A new root waits before its first automatic request.
    await expect(read()).resolves.toBeUndefined();
    now += RELEASE_FIRST_CHECK_DELAY_MS;
    await expect(read()).resolves.toBe("0.173.0");
    expect(network).toHaveBeenCalledWith(CODEX_NPM_LATEST_URL, expect.anything());
    now += CODEX_LATEST_CHECK_TTL_MS - 1;
    await expect(read()).resolves.toBe("0.173.0");
    expect(network).toHaveBeenCalledTimes(1);
    now += 1;
    await read();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ version: "0.174.0-alpha.1" }, /unexpected Codex version/u],
    [{ name: "@openai/codex" }, /has no version/u],
  ])("refuses %j", async (body, message) => {
    let now = 1_000_000;
    const read = () => fetchLatestCodexVersion({
      fetch: async () => new Response(JSON.stringify(body)),
      directory,
      now: () => now,
    });
    await expect(read()).resolves.toBeUndefined();
    now += RELEASE_FIRST_CHECK_DELAY_MS;
    await expect(read()).rejects.toThrow(message);
  });
});

type Harness = {
  service: CodexUserUpdateService;
  states: CodexUserUpdateState[];
  target: { current: CodexUpdateTarget | undefined };
  rediscover: ReturnType<typeof vi.fn>;
  restartCodex: ReturnType<typeof vi.fn>;
  calls: ReturnType<typeof fakeSpawn>["calls"];
  settled: () => Promise<CodexUserUpdateState>;
};

function harness(params: {
  version?: string;
  versionAfter?: string;
  latest?: string;
  exitCode?: number;
  resolvedPath?: string;
  command?: string;
  overrides?: Partial<CodexUserUpdateServiceOptions>;
}): Harness {
  const target = {
    current: {
      command: params.command ?? "/opt/homebrew/bin/codex",
      version: params.version ?? "0.172.0",
      managedByPwrAgent: false,
    } as CodexUpdateTarget | undefined,
  };
  const { spawn, calls } = fakeSpawn({ code: params.exitCode ?? 0, output: "done\n" });
  const rediscover = vi.fn(async () => {
    if (target.current && params.versionAfter) {
      target.current = { ...target.current, version: params.versionAfter };
    }
  });
  const restartCodex = vi.fn(async () => undefined);
  const states: CodexUserUpdateState[] = [];
  const service = new CodexUserUpdateService({
    readTarget: async () => target.current,
    resolvePath: async () => params.resolvedPath ?? "/opt/homebrew/Caskroom/codex/0.172.0/bin/codex",
    resolveEnv: async () => ({ PATH: "/usr/bin" }),
    fetchLatestVersion: async () => params.latest ?? "0.173.0",
    rediscover,
    restartCodex,
    isExecutable: ALL_EXECUTABLE,
    resolveOnPath: NOT_ON_PATH,
    platform: "darwin",
    now: () => 5_000,
    spawn,
    ...params.overrides,
  });
  service.subscribe((state) => states.push(state));
  const settled = async (): Promise<CodexUserUpdateState> => {
    await vi.waitFor(() => {
      const phase = service.snapshot().run?.phase;
      expect(["succeeded", "unchanged", "failed"]).toContain(phase);
    });
    return service.snapshot();
  };
  return { service, states, target, rediscover, restartCodex, calls, settled };
}

async function readUntilOffered(service: CodexUserUpdateService): Promise<CodexUserUpdateState> {
  await service.readState();
  await vi.waitFor(() => expect(service.snapshot().offer).toBeDefined());
  return service.snapshot();
}

describe("CodexUserUpdateService", () => {
  it("offers a runnable Homebrew update, runs it, verifies the new version, then restarts Codex", async () => {
    const h = harness({ versionAfter: "0.173.0" });
    expect((await readUntilOffered(h.service)).offer).toEqual({
      installedVersion: "0.172.0",
      latestVersion: "0.173.0",
      installer: "homebrew",
      upgradeCommand: "brew upgrade --cask codex",
      canRunUpdate: true,
    });
    const started = await h.service.startUpdate();
    expect(started.run?.phase).toBe("updating");
    const done = await h.settled();
    expect(done.run).toMatchObject({ phase: "succeeded", fromVersion: "0.172.0", toVersion: "0.173.0" });
    expect(done.offer).toBeUndefined();
    expect(h.calls).toEqual([expect.objectContaining({
      file: "/opt/homebrew/bin/brew",
      args: ["upgrade", "--cask", "codex"],
    })]);
    expect(h.rediscover).toHaveBeenCalledTimes(1);
    expect(h.restartCodex).toHaveBeenCalledTimes(1);
    expect(h.states.map((state) => state.run?.phase).filter(Boolean)).toEqual(
      expect.arrayContaining(["updating", "verifying", "restarting", "succeeded"]),
    );
  });

  it("reports an installer with nothing newer without restarting Codex", async () => {
    const h = harness({ versionAfter: "0.172.0" });
    await readUntilOffered(h.service);
    await h.service.startUpdate();
    const done = await h.settled();
    expect(done.run).toMatchObject({ phase: "unchanged", toVersion: "0.172.0", targetVersion: "0.173.0" });
    expect(h.restartCodex).not.toHaveBeenCalled();
  });

  it("reports a failed installer with its output and leaves Codex alone", async () => {
    const h = harness({ exitCode: 1 });
    await readUntilOffered(h.service);
    await h.service.startUpdate();
    const done = await h.settled();
    expect(done.run).toMatchObject({ phase: "failed", error: "The update exited with code 1.", outputTail: "done\n" });
    expect(h.rediscover).not.toHaveBeenCalled();
    expect(h.restartCodex).not.toHaveBeenCalled();
  });

  it("runs one update at a time", async () => {
    const h = harness({ versionAfter: "0.173.0" });
    await readUntilOffered(h.service);
    const [first, second] = await Promise.all([h.service.startUpdate(), h.service.startUpdate()]);
    expect(first.run?.id).toBe(second.run?.id);
    await h.settled();
    expect(h.calls).toHaveLength(1);
  });

  it("offers an unrecognized install without ever running anything", async () => {
    const h = harness({ resolvedPath: "/opt/tools/codex", command: "/opt/tools/codex" });
    const state = await readUntilOffered(h.service);
    expect(state.offer).toMatchObject({ installer: "unknown", canRunUpdate: false });
    expect(state.offer?.upgradeCommand).toBeUndefined();
    await expect(h.service.startUpdate()).rejects.toThrow(/cannot run an update/u);
    expect(h.calls).toHaveLength(0);
  });

  it("offers nothing for a current Codex or PwrAgent's own build", async () => {
    const settleReads = async (service: CodexUserUpdateService) => {
      await service.readState();
      // Let the latest-release check land, then read with its answer.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await service.readState();
    };
    const current = harness({ version: "0.173.0" });
    expect((await settleReads(current.service)).offer).toBeUndefined();

    const managed = harness({});
    managed.target.current = { ...managed.target.current!, managedByPwrAgent: true };
    expect((await settleReads(managed.service)).offer).toBeUndefined();

    // The control: the same harness does offer for an older stock Codex.
    expect((await settleReads(harness({}).service)).offer).toBeDefined();
  });

  it("stays silent and refuses to run when checks are disabled", async () => {
    const fetchLatestVersion = vi.fn(async () => "0.173.0");
    const h = harness({ overrides: { checksDisabled: true, fetchLatestVersion } });
    await expect(h.service.readState()).resolves.toEqual({});
    await expect(h.service.startUpdate()).rejects.toThrow();
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });
});
