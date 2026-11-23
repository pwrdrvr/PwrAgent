import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/client";
import type { CodexClientHost, CodexClientTransport } from "../codex-app-server/host";

type Call = { method: string; params?: Record<string, unknown> };

function testHost(transport: CodexClientTransport): CodexClientHost {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
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
}

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
        const client = new CodexAppServerClient({}, testHost(transport));
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

describe("Codex thread skill exclusions", () => {
  it("adds only the owning thread's exclusions to the launch rules on start and cold resume", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 5 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 5 }),
      async (left, right) => {
        const cwd = "/fixture/project";
        const requests: Call[] = [];
        const launchRules = [{ name: "private-skill", enabled: false }, { name: "override-skill", enabled: true }];
        const snapshots = new Map<string, string[]>();
        let receive: (message: string) => void = () => undefined;
        let nextId = 0;
        const transport: CodexClientTransport = {
          connect: async () => undefined,
          close: async () => undefined,
          setCloseHandler: () => undefined,
          setMessageHandler: (handler) => { receive = handler; },
          send: (message) => {
            const request = JSON.parse(message) as Call & { id?: number };
            if (request.id === undefined) return;
            requests.push(request);
            let result: unknown = {};
            if (request.method === "initialize") {
              result = { userAgent: "fixture/0.164.0", codexHome: "/fixture/codex", platformFamily: "unix", platformOs: "macos" };
            } else if (request.method === "config/read") {
              expect(request.params?.includeLayers).toBe(true);
              result = { layers: [
                { name: { type: "sessionFlags" }, config: { skills: { config: launchRules } } },
                { name: { type: "user" }, config: { skills: { config: [{ name: "user-skill", enabled: false }] } } },
              ] };
            } else if (["thread/start", "thread/resume", "thread/read"].includes(request.method)) {
              const id = request.params?.threadId ?? `fixture-${++nextId}`;
              result = { thread: { id, cwd, turns: [], modelProvider: "openai", name: "Fixture" }, model: "gpt-5.4" };
            } else if (request.method === "turn/start") {
              result = { turn: { id: `turn-${++nextId}`, status: "inProgress", items: [] } };
            }
            receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
          },
        };
        const client = new CodexAppServerClient({}, testHost(transport));
        const profiles = [
          left.map((number) => `alpha-${number}`),
          right.map((number) => `bravo-${number}`),
          [],
        ];
        const rulesFor = (names: string[]) => names.length
          ? [...launchRules, ...names.map((name) => ({ name, enabled: false }))]
          : undefined;
        const configFor = (call: Call | undefined) =>
          (call?.params?.config as Record<string, unknown> | undefined)?.["skills.config"];
        client.provideThreadSkillExclusions(async (id) => snapshots.get(id));
        try {
          const started = await Promise.all(profiles.map((skillExclusions) =>
            client.startThread({ cwd, skillExclusions })));
          const starts = requests.filter(({ method }) => method === "thread/start");
          // Concurrent configuration reads can change admission order, so the
          // provider's returned id is the oracle for matching a start request.
          for (const [index, { threadId }] of started.entries()) {
            snapshots.set(threadId, profiles[index]!);
            const wireIndex = Number(threadId.split("-").at(-1)) - 1;
            expect(configFor(starts[wireIndex])).toEqual(rulesFor(profiles[index]!));
          }
          expect(requests.filter(({ method }) => method === "config/read")).toHaveLength(1);
          await client.close();
          await Promise.all(started.map(({ threadId }) =>
            client.startTurn({ threadId, cwd, input: [{ type: "text", text: "Fixture turn" }] })));
          for (const { threadId } of started) {
            expect(configFor(requests.find(({ method, params }) =>
              method === "thread/resume" && params?.threadId === threadId))).toEqual(rulesFor(snapshots.get(threadId)!));
          }
          expect(requests.filter(({ method }) => method === "config/read")).toHaveLength(2);
          expect(requests.some(({ method }) => method === "skills/config/write")).toBe(false);
        } finally {
          await client.close();
        }
      },
    ), { numRuns: 15 });
  });
});
