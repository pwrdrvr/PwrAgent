import {
  AppServerSessionState,
  CodexAppServer,
  GrokRolloutStore,
  type AppServerProvider,
  type ProviderActiveTurn,
  type ProviderTurnEventListener,
  type ProviderTurnParams,
} from "@pwragent/agent-core";
import type { ProcessAppServer } from "../process-app-server.js";
import { runStdioJsonRpcServer } from "../stdio-json-rpc-server.js";

class RequestingProvider implements AppServerProvider {
  startTurn(_params: ProviderTurnParams): ProviderActiveTurn {
    const listeners = new Set<ProviderTurnEventListener>();
    let resolveInput!: (value: unknown) => void;
    const inputResponse = new Promise<unknown>((resolve) => {
      resolveInput = resolve;
    });
    const result = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      for (const listener of listeners) {
        await listener({
          type: "request_input",
          requestId: "approval-1",
          method: "turn/requestApproval",
          params: {
            requestId: "approval-1",
            threadId: "thread-1",
            turnId: "turn-1",
            reason: "integration test",
          },
          respond: async (response) => resolveInput(response),
        });
      }
      const response = await inputResponse;
      return {
        assistantText: `Desktop responded ${JSON.stringify(response)}`,
        providerResponseId: "response-1",
      };
    })();

    return {
      result,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      interrupt: async () => undefined,
    };
  }
}

const server = new CodexAppServer({
  provider: new RequestingProvider(),
  sessionState: new AppServerSessionState({
    store: new GrokRolloutStore(
      process.env.PWRAGENT_GROK_PROFILE_STATE_ROOT ?? process.cwd(),
    ),
  }),
  threadIdGenerator: () => "thread-1",
  turnIdGenerator: () => "turn-1",
});
let shutdownRequested = false;
const processServer: ProcessAppServer = {
  request: async (method, params) => {
    if (method === "shutdown") {
      shutdownRequested = true;
      return {};
    }
    return await server.request(method, params);
  },
  notify: async (method, params) => {
    await server.notify(method, params);
  },
  onNotification: (handler) =>
    server.onNotification(async (notification) => {
      await handler({
        method: notification.method,
        params: notification.params as Record<string, unknown>,
      });
    }),
  onRequest: (handler) => server.onRequest(handler),
  shouldShutdown: () => shutdownRequested,
};

runStdioJsonRpcServer({ server: processServer });
