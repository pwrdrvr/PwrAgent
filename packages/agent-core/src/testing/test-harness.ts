import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppServerNotification, AppServerTurnInputItem, ThreadState } from "../app-server/protocol.js";
import { CodexAppServer } from "../app-server/codex-app-server.js";
import type {
  AppServerProvider,
  ProviderActiveTurn,
  ProviderSteerParams,
  ProviderTurnParams,
  ProviderTurnResult,
} from "../providers/provider-contract.js";

export class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export type FakeProviderRun = {
  thread: ThreadState;
  input: AppServerTurnInputItem[];
  previousResponseId?: string;
  deferred: Deferred<ProviderTurnResult>;
  steerCalls: ProviderSteerParams[];
  interrupted: boolean;
};

export class FakeProvider implements AppServerProvider {
  readonly runs: FakeProviderRun[] = [];

  startTurn(params: ProviderTurnParams): ProviderActiveTurn {
    const deferred = new Deferred<ProviderTurnResult>();
    const run: FakeProviderRun = {
      thread: params.thread,
      input: params.input,
      previousResponseId: params.previousResponseId,
      deferred,
      steerCalls: [],
      interrupted: false,
    };
    this.runs.push(run);
    return {
      result: deferred.promise,
      steer: async (steerParams) => {
        run.steerCalls.push(steerParams);
      },
      interrupt: async () => {
        run.interrupted = true;
      },
    };
  }
}

export function createTestHarness(options?: {
  provider?: AppServerProvider;
}) {
  const provider = options?.provider ?? new FakeProvider();
  const notifications: AppServerNotification[] = [];
  const server = new CodexAppServer({
    provider,
    threadIdGenerator: (() => {
      let index = 0;
      return () => `thread-${++index}`;
    })(),
    runIdGenerator: (() => {
      let index = 0;
      return () => `turn-${++index}`;
    })(),
  });
  server.onNotification(async (notification) => {
    notifications.push(notification);
  });
  return { server, provider, notifications };
}

export async function createTemporaryTestDirectory(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), "pwragnt-agent-core-"));
  return {
    path: tempPath,
    cleanup: async () => {
      await fs.rm(tempPath, { recursive: true, force: true });
    },
  };
}
