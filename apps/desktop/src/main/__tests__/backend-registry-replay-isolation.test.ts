import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";

const REPLAY_FIXTURE_PATH_ENV = "PWRAGENT_REPLAY_FIXTURE_PATH";

const constructorState = vi.hoisted(() => ({
  codexCount: 0,
  codexArgs: [] as Array<string[] | undefined>,
  codexEnvs: [] as Array<NodeJS.ProcessEnv | undefined>,
  codexMetadataHomes: [] as Array<string | undefined>,
  grokCount: 0,
}));

vi.mock("../codex-app-server/client", () => ({
  CodexAppServerClient: class {
    constructor(options?: { args?: string[]; env?: NodeJS.ProcessEnv }) {
      constructorState.codexCount += 1;
      constructorState.codexArgs.push(options?.args);
      constructorState.codexEnvs.push(options?.env);
    }

    async close(): Promise<void> {
      return;
    }

    async getInitializeResult() {
      return {};
    }

    async listThreads() {
      return [];
    }

    async listSkills() {
      return [];
    }

    onNotification() {
      return () => undefined;
    }

    onRequest() {
      return () => undefined;
    }

    async readThread() {
      return {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      };
    }

    async startThread() {
      return { threadId: "noop-thread" };
    }

    async startTurn() {
      return { threadId: "noop-thread", turnId: "noop-turn" };
    }

    async interruptTurn() {
      return { threadId: "noop-thread", turnId: "noop-turn" };
    }
  }
}));

vi.mock("../app-server/codex-session-metadata-service", () => ({
  CodexSessionMetadataService: class {
    constructor(options?: { codexHome?: string }) {
      constructorState.codexMetadataHomes.push(options?.codexHome);
    }

    async updateThreadCwd() {
      return { updated: false, reason: "missing-session" };
    }
  },
}));

const settingsState = vi.hoisted(() => ({
  codexEnv: undefined as NodeJS.ProcessEnv | undefined,
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    resolveCodexCommandPreference: () => undefined,
    resolveCodexSpawnEnv: () => settingsState.codexEnv,
    resolveWorktreeStorage: () => "in-repo",
  }),
}));

vi.mock("../grok-app-server/client", () => ({
  GrokAppServerClient: class {
    constructor() {
      constructorState.grokCount += 1;
    }

    async close(): Promise<void> {
      return;
    }

    async getInitializeResult() {
      return {};
    }

    async listThreads() {
      return [];
    }

    async listSkills() {
      return [];
    }

    onNotification() {
      return () => undefined;
    }

    onRequest() {
      return () => undefined;
    }

    async readThread() {
      return {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      };
    }

    async startThread() {
      return { threadId: "noop-thread" };
    }

    async startTurn() {
      return { threadId: "noop-thread", turnId: "noop-turn" };
    }

    async interruptTurn() {
      return { threadId: "noop-thread", turnId: "noop-turn" };
    }
  }
}));

const tempDirs: string[] = [];

function createOverlayStoreMock() {
  return {
    getThreadOverlayState: async () => undefined,
    getThreadOverlayStates: async ({ threadIds }: { threadIds: string[] }) =>
      Object.fromEntries(threadIds.map((threadId) => [threadId, undefined])),
    setThreadExecutionMode: async ({
      backend,
      threadId,
      executionMode,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      executionMode: "default" | "full-access";
    }) => ({
      backend,
      threadId,
      executionMode,
      extraLinkedDirectories: [],
    }),
  } as unknown as InstanceType<typeof import("@pwragent/agent-core").OverlayStore>;
}

beforeEach(() => {
  constructorState.codexCount = 0;
  constructorState.codexArgs = [];
  constructorState.codexEnvs = [];
  constructorState.codexMetadataHomes = [];
  constructorState.grokCount = 0;
  settingsState.codexEnv = undefined;
});

afterEach(() => {
  delete process.env[REPLAY_FIXTURE_PATH_ENV];
  delete globalThis.__PWRAGENT_REPLAY_DRIVER__;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DesktopBackendRegistry replay isolation", () => {
  it("does not instantiate live clients for a codex replay fixture", async () => {
    process.env[REPLAY_FIXTURE_PATH_ENV] = writeFixture({
      metadata: {
        backend: "codex",
        scenario: "registry-replay-codex"
      },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: {
              name: "Replay Codex",
              version: "1.0.0"
            },
            methods: ["thread/list"]
          }
        },
        {
          id: "list-1",
          kind: "response",
          method: "thread/list",
          result: []
        }
      ]
    });

    const registry = new DesktopBackendRegistry({
      overlayStore: createOverlayStoreMock(),
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([]);
    expect(constructorState.codexCount).toBe(0);
    expect(constructorState.grokCount).toBe(0);

    await registry.close();
  });

  it("does not instantiate live clients for a grok replay fixture", async () => {
    process.env[REPLAY_FIXTURE_PATH_ENV] = writeFixture({
      metadata: {
        backend: "grok",
        scenario: "registry-replay-grok"
      },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: {
              name: "Replay Grok",
              version: "1.0.0"
            },
            methods: ["thread/list"]
          }
        },
        {
          id: "list-1",
          kind: "response",
          method: "thread/list",
          result: []
        }
      ]
    });

    const registry = new DesktopBackendRegistry({
      overlayStore: createOverlayStoreMock(),
    });

    await expect(registry.listThreads({ backend: "grok" })).resolves.toEqual([]);
    expect(constructorState.codexCount).toBe(0);
    expect(constructorState.grokCount).toBe(0);

    await registry.close();
  });

  it("spawns exactly one codex child process with workspace-write defaults so newly created threads inherit Default Access", async () => {
    const registry = new DesktopBackendRegistry({
      overlayStore: createOverlayStoreMock(),
    });

    expect(constructorState.codexCount).toBe(1);
    expect(constructorState.codexArgs).toEqual([
      [
        "-c",
        'approval_policy="on-request"',
        "-c",
        'sandbox_mode="workspace-write"',
      ],
    ]);

    await registry.close();
  });

  it("passes the selected Codex home to the live client and metadata helper", async () => {
    const codexHome = path.join(os.tmpdir(), "pwragent-codex-profile-home");
    settingsState.codexEnv = {
      CODEX_HOME: codexHome,
    } as NodeJS.ProcessEnv;

    const registry = new DesktopBackendRegistry({
      overlayStore: createOverlayStoreMock(),
    });

    expect(constructorState.codexCount).toBe(1);
    expect(constructorState.codexEnvs[0]?.CODEX_HOME).toBe(codexHome);
    expect(constructorState.codexMetadataHomes).toEqual([codexHome]);

    await registry.close();
  });
});

function writeFixture(fixture: unknown): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-registry-replay-"));
  tempDirs.push(tempDir);

  const fixturePath = path.join(tempDir, "replay.fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
  return fixturePath;
}
