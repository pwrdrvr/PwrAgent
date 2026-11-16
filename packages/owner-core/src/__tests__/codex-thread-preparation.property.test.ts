import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/client";
import type { CodexClientHost, CodexClientTransport } from "../codex-app-server/host";

describe("Host thread request preparation", () => {
  it("prepares all start, resume, and fork requests before sending without changing caller config", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("start", "resume", "fork"), { minLength: 3, maxLength: 6 }),
      async (operations) => {
        const credentials = {
          config: { mcp_servers: {
            unrelated: { env: { API_KEY: "fixture-runtime-env-credential" }, http_headers: {
              Authorization: "Bearer fixture-runtime-header-credential",
            } },
          } },
        };
        const observedMessages: string[] = [];
        let receive: (message: string) => void = () => undefined;
        const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
        const transport: CodexClientTransport = {
          connect: async () => undefined,
          close: async () => undefined,
          setCloseHandler: () => undefined,
          setMessageHandler: (handler) => { receive = handler; },
          send: (message) => {
            const request = JSON.parse(message);
            if (request.id === undefined) return;
            sent.push(request);
            let result: unknown = {};
            if (request.method === "initialize") result = {
              userAgent: "fixture", codexHome: "/fixture", platformFamily: "unix", platformOs: "macos",
            };
            if (request.method === "config/read") result = credentials;
            if (request.method.startsWith("thread/")) result = {
              thread: { id: request.params.threadId ?? "created", status: { type: "idle" }, turns: [] },
            };
            receive(JSON.stringify({ id: request.id, result }));
          },
        };
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const prepared: string[] = [];
        const host: CodexClientHost = {
          createTransport: () => transport,
          clientInfo: { name: "fixture", title: "Fixture" },
          logger,
          rpcLogger: logger,
          listingDiagnostics: { trace: async (_stage, _fields, operation) => await operation(), link: () => undefined },
          authState: { isBlocked: () => false, assertAvailable: () => undefined },
          signInRequiredMessage: "Sign in",
          buildShellEnvironment: (env) => env,
          enrichThreadDirectory: async () => ({ linkedDirectories: [] }),
          sampleAppServerProcessTree: async () => ({}),
          prepareThreadRequest: async ({ method, params, request }) => {
            prepared.push(method);
            // Diagnostics must redact both raw bytes and the parsed envelope,
            // while preparation still receives the complete protocol response.
            expect(await request("config/read", { includeLayers: false })).toEqual(credentials);
            const original = params as { config?: Record<string, unknown> };
            return { ...original, config: { ...original.config, host_prepared: true } };
          },
        };
        const client = new CodexAppServerClient({
          connectionObserver: { onMessage: (event) => { observedMessages.push(JSON.stringify(event)); } },
        }, host);
        const config = { sentinel: "preserved" };
        try {
          for (const operation of ["start", "resume", "fork", ...operations]) {
            const params = { cwd: "/fixture", config };
            if (operation === "start") await client.startThread(params);
            else if (operation === "resume") await client.resumeNativeVoiceThread({ ...params, threadId: "existing" });
            else await client.forkThread({ ...params, threadId: "existing" });
          }
          const threadRequests = sent.filter(({ method }) =>
            method === "thread/start" || method === "thread/resume" || method === "thread/fork",
          );
          expect(threadRequests.map(({ method }) => method)).toEqual(prepared);
          expect(threadRequests.length).toBe(operations.length + 3);
          for (const request of threadRequests) {
            expect(request.params.config).toMatchObject({ sentinel: "preserved", host_prepared: true });
          }
          expect(config).toEqual({ sentinel: "preserved" });
          const captured = observedMessages.join("\n");
          expect(captured).toContain("unrelated");
          expect(captured).not.toContain("fixture-runtime-env-credential");
          expect(captured).not.toContain("fixture-runtime-header-credential");
        } finally {
          await client.close();
        }
      },
    ), { numRuns: 25 });
  });
});
