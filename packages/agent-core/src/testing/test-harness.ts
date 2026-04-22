import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppServerNotification, AppServerTurnInputItem, ThreadState } from "../app-server/internal-contract.js";
import { CodexAppServer } from "../app-server/codex-app-server.js";
import { AppServerSessionState } from "../app-server/session-state.js";
import type {
  AppServerProvider,
  ProviderActiveTurn,
  ProviderSteerParams,
  ProviderTurnEvent,
  ProviderTurnEventListener,
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
  eventResponses: unknown[];
  emit: (event: ProviderTurnEvent) => Promise<void>;
};

export class FakeProvider implements AppServerProvider {
  readonly runs: FakeProviderRun[] = [];

  startTurn(params: ProviderTurnParams): ProviderActiveTurn {
    const deferred = new Deferred<ProviderTurnResult>();
    const listeners = new Set<ProviderTurnEventListener>();
    const run: FakeProviderRun = {
      thread: params.thread,
      input: params.input,
      previousResponseId: params.previousResponseId,
      deferred,
      steerCalls: [],
      interrupted: false,
      eventResponses: [],
      emit: async (event) => {
        const eventWithCapture =
          event.type === "request_input"
            ? {
                ...event,
                respond: async (response: unknown) => {
                  run.eventResponses.push(response);
                  await event.respond(response);
                },
              }
            : event;
        for (const listener of listeners) {
          await listener(eventWithCapture);
        }
      },
    };
    this.runs.push(run);
    return {
      result: deferred.promise,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
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
  requestHandler?: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
  sessionState?: AppServerSessionState;
}) {
  const provider = options?.provider ?? new FakeProvider();
  const notifications: AppServerNotification[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = new CodexAppServer({
    provider,
    sessionState: options?.sessionState,
    threadIdGenerator: (() => {
      let index = 0;
      return () => `thread-${++index}`;
    })(),
    turnIdGenerator: (() => {
      let index = 0;
      return () => `turn-${++index}`;
    })(),
  });
  server.onNotification(async (notification) => {
    notifications.push(notification);
  });
  server.onRequest(async (method, params) => {
    const normalized = (params ?? {}) as Record<string, unknown>;
    requests.push({ method, params: normalized });
    if (options?.requestHandler) {
      return await options.requestHandler(method, normalized);
    }
    return { decision: "approve" };
  });
  return { server, provider, notifications, requests };
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
