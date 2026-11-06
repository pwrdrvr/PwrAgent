import { CodexAppServerClient } from "../../dist/federation-core.js";

export function fixtureCodexClient(read) {
  let receive;
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const codex = new CodexAppServerClient({ requestTimeoutMs: 2000 }, {
    createTransport: () => ({
      connect: async () => {}, close: async () => {}, setCloseHandler() {},
      setMessageHandler: (handler) => { receive = handler; },
      send: (raw) => {
        const { id, method, params } = JSON.parse(raw);
        if (id === undefined) return;
        void (async () => {
          let result;
          if (method === "initialize") {
            result = { userAgent: "fixture-codex/0.159.2", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux" };
          } else {
            result = await read("thread/read", params);
            if (method === "thread/turns/list") {
              result = { data: (result.thread.turns || []).slice().reverse().map((turn) => ({ ...turn, itemsView: "full" })), nextCursor: null };
            } else if (result.thread) {
              result.thread = { id: params.threadId, ...result.thread };
            }
          }
          receive(JSON.stringify({ id, result }));
        })().catch((error) => receive(JSON.stringify({ id, error: { code: -32603, message: error.message } })));
      },
    }),
    clientInfo: { name: "fixture", title: "Fixture" },
    logger, rpcLogger: logger,
    listingDiagnostics: { trace: (_stage, _fields, work) => work(), link() {} },
    authState: { isBlocked: () => false, assertAvailable() {} }, signInRequiredMessage: "Sign in required",
    buildShellEnvironment: (env) => env, enrichThreadDirectory: async () => ({ linkedDirectories: [] }),
    sampleAppServerProcessTree: async () => ({}),
  });
  return codex;
}
