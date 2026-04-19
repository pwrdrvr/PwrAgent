import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";

const REPLAY_FIXTURE_PATH_ENV = "PWRAGNT_REPLAY_FIXTURE_PATH";

const constructorState = vi.hoisted(() => ({
  codexCount: 0,
  grokCount: 0,
}));

vi.mock("../codex-app-server/client", () => ({
  CodexAppServerClient: class {
    constructor() {
      constructorState.codexCount += 1;
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
      return { threadId: "noop-thread", runId: "noop-turn" };
    }

    async interruptTurn() {
      return { threadId: "noop-thread", runId: "noop-turn" };
    }
  }
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
      return { threadId: "noop-thread", runId: "noop-turn" };
    }

    async interruptTurn() {
      return { threadId: "noop-thread", runId: "noop-turn" };
    }
  }
}));

const tempDirs: string[] = [];

function createOverlayStoreMock() {
  return {
    getThreadOverlayState: async () => undefined,
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
  } as unknown as InstanceType<typeof import("@pwragnt/agent-core").OverlayStore>;
}

beforeEach(() => {
  constructorState.codexCount = 0;
  constructorState.grokCount = 0;
});

afterEach(() => {
  delete process.env[REPLAY_FIXTURE_PATH_ENV];
  delete globalThis.__PWRAGNT_REPLAY_DRIVER__;

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
});

function writeFixture(fixture: unknown): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragnt-registry-replay-"));
  tempDirs.push(tempDir);

  const fixturePath = path.join(tempDir, "replay.fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
  return fixturePath;
}
