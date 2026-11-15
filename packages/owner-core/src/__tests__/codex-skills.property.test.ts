import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/client";
import type { CodexClientHost, CodexClientTransport } from "../codex-app-server/host";

describe("Codex skill discovery freshness", () => {
  it("matches the authoritative catalog after external edits despite a per-cwd server cache", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { maxLength: 8 }),
      async (edits) => {
        const cwd = "/fixture/project";
        let catalog = ["rate-math-paper"];
        let cached: string[] | undefined;
        let receive: (message: string) => void = () => undefined;
        const transport: CodexClientTransport = {
          connect: async () => undefined,
          close: async () => undefined,
          setCloseHandler: () => undefined,
          setMessageHandler: (handler) => { receive = handler; },
          send: (message) => {
            const request = JSON.parse(message);
            if (request.id === undefined) return;
            let result: unknown = {
              userAgent: "fixture",
              codexHome: "/fixture/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            };
            if (request.method === "skills/list") {
              expect(request.params.cwds).toEqual([cwd]);
              // Model the documented discovery cache. External edits change
              // the oracle catalog without emitting a watched-file event.
              if (!cached || request.params.forceReload === true) cached = [...catalog];
              result = { data: [{ cwd, skills: cached.map((name) => ({
                name, description: name, path: `${cwd}/.agents/skills/${name}/SKILL.md`,
              })) }] };
            } else {
              expect(request.method).toBe("initialize");
            }
            receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
          },
        };
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
        };
        const client = new CodexAppServerClient({}, host);
        try {
          const read = async () => (await client.listSkills({ cwd, cwds: [cwd] }))
            .flatMap((entry) => entry.skills.map((skill) => skill.name));
          expect(await read()).toEqual(catalog);
          for (const present of [true, false, ...edits]) {
            catalog = present ? ["rate-math-paper", "paper-rewriter-pwragent"] : ["rate-math-paper"];
            expect(await read()).toEqual(catalog);
          }
        } finally {
          await client.close();
        }
      },
    ), { numRuns: 25 });
  });
});
