import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { AcpSessionRuntimeOptions } from "../app-server/acp-session-runtime-options";
import { AcpSessionStore } from "../storage/acp-session-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const modes = ["default", "accept-edits", "auto", "plan"] as const;
const sessionId = "antigravity-session";

function configOptions(currentValue: string) {
  return [{
    id: "mode",
    category: "mode",
    type: "select",
    currentValue,
    options: modes.map((value) => ({ value, name: value })),
  }];
}

// Antigravity 1.5.15 starts each session/load worker in Default. Its
// set_config_option reply has configOptions, while load also has legacy modes.
class AntigravityTransport extends FakeAcpAgentTransport {
  mode = "default";
  readonly sentPrompts: string[] = [];
  refusedMode?: string;
  refuseClose = false;
  workerOpen = false;

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const result = super.request(method, params, timeoutMs);
    if (method === "session/new" || method === "session/load") {
      this.workerOpen = true;
      this.mode = "default";
      return {
        sessionId,
        configOptions: configOptions(this.mode),
        modes: {
          currentModeId: this.mode,
          availableModes: modes.map((id) => ({ id, name: id })),
        },
      };
    }
    if (method === "session/set_config_option" && params?.configId === "mode") {
      if (params.value !== this.refusedMode) this.mode = String(params.value);
      this.emitSessionUpdate(sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: this.mode,
      });
      return { configOptions: configOptions(this.mode) };
    }
    if (method === "session/close") {
      if (this.refuseClose) throw new Error("Provider refused to close");
      this.workerOpen = false;
    }
    if (method === "session/prompt") {
      this.sentPrompts.push(this.mode);
      this.emitSessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      });
    }
    return result;
  }
}

async function withSession(
  run: (fixture: {
    store: AcpSessionStore;
    open: (
      onSessionRuntimeStateChange?: ConstructorParameters<typeof AcpAgentClient>[0]["onSessionRuntimeStateChange"],
    ) => Promise<{
      client: AcpAgentClient;
      transport: AntigravityTransport;
    }>;
    select: (client: AcpAgentClient, mode: string) => Promise<unknown>;
  }) => Promise<void>,
) {
  const stateDb = openInMemoryStateDb();
  const store = new AcpSessionStore(stateDb);
  const clients: AcpAgentClient[] = [];
  let first = true;
  try {
    await run({
      store,
      open: async (onSessionRuntimeStateChange) => {
        const transport = new AntigravityTransport({
          initialize: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
          },
        });
        const client = new AcpAgentClient({
          backendId: "acp:antigravity",
          store,
          transport,
          onSessionRuntimeStateChange,
        });
        clients.push(client);
        await client.initialize();
        if (first) {
          first = false;
          await client.startSession({ cwd: "/repo", executionMode: "default" });
        }
        return { client, transport };
      },
      select: (client, value) => client.setRuntimeOption({
        sessionId,
        source: "configOption",
        optionId: "mode",
        value,
      }),
    });
  } finally {
    await Promise.all(clients.map((client) => client.dispose()));
    stateDb.close();
  }
}

async function finishPrompt(client: AcpAgentClient) {
  await client.startPrompt({ sessionId, prompt: "Search for the marker" });
  await vi.waitFor(() => expect(client.hasActiveTurns()).toBe(false), { interval: 1 });
}

function selectModeThroughOwner(client: AcpAgentClient, store: AcpSessionStore, value: string) {
  const owner = new AcpSessionRuntimeOptions({
    getSession: (backend, threadId) => store.getSession(backend, threadId),
    getClientForSession: async () => client,
    getInstalledAgent: () => undefined,
    upsertSession: (metadata) => store.upsertSession(metadata),
  }, {
    setThreadExecutionMode: async (params) => ({ ...params, extraLinkedDirectories: [] }),
  }, async () => {}, () => ({
    threadHasActiveTurn: () => false,
    appendPermissionTransition: async () => {},
  }));
  return owner.setAcpSessionRuntimeOption({
    backend: "acp:antigravity",
    threadId: sessionId,
    source: "configOption",
    optionId: "mode",
    value,
  });
}

describe("Antigravity native mode on session/load", () => {
  it("keeps launchpad Auto when the first turn is sent through a new client", async () => {
    await withSession(async ({ open, select, store }) => {
      const startup = await open();
      await select(startup.client, "auto");

      const onSessionRuntimeStateChange = vi.fn();
      const { client, transport } = await open(onSessionRuntimeStateChange);
      await client.ensureSession(store.getSession("acp:antigravity", sessionId)!);
      await finishPrompt(client);
      expect(transport.sentPrompts).toEqual(["auto"]);
      const restoredMode = {
        currentModeId: "auto",
        configValues: { mode: "auto" },
      };
      expect(store.getSession("acp:antigravity", sessionId)?.acpRuntime).toMatchObject(restoredMode);
      expect(onSessionRuntimeStateChange).toHaveBeenCalledExactlyOnceWith({
        fromSessionLoad: true,
        sessionId,
        runtimeState: expect.objectContaining(restoredMode),
      });
    });
  });

  it("sends each prompt in the last acknowledged mode after an idle reload", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom(...modes), { minLength: 1, maxLength: 6 }),
      async (choices) => {
        await withSession(async ({ open, select, store }) => {
          const { client, transport } = await open();
          for (const mode of choices) {
            await select(client, mode);
            expect(await client.closeIdleSessions({ idleMs: 0 })).toEqual([sessionId]);
            const nextRequest = transport.requests.length;
            await finishPrompt(client);
            expect(transport.sentPrompts.at(-1)).toBe(mode);
            expect(transport.requests.slice(nextRequest).map(({ method }) => method)).toEqual(
              mode === "default"
                ? ["session/load", "session/prompt"]
                : ["session/load", "session/set_config_option", "session/prompt"],
            );
            expect(store.getSession("acp:antigravity", sessionId)?.acpRuntime).toMatchObject({
              currentModeId: mode,
              configValues: { mode },
            });
          }
        });
      },
    ), { numRuns: 25 });
  });

  it("keeps the saved mode and withholds the prompt when the worker does not restore it", async () => {
    await withSession(async ({ open, select, store }) => {
      const { client, transport } = await open();
      await select(client, "auto");
      expect(await client.closeIdleSessions({ idleMs: 0 })).toEqual([sessionId]);
      transport.refusedMode = "auto";
      await expect(client.startPrompt({ sessionId, prompt: "Search for the marker" })).rejects.toThrow(/restore.*auto/i);
      expect(transport.sentPrompts).toEqual([]);
      expect(store.getSession("acp:antigravity", sessionId)?.acpRuntime?.currentModeId).toBe("auto");

      transport.refusedMode = undefined;
      await finishPrompt(client);
      expect(transport.sentPrompts).toEqual(["auto"]);
    });
  });

  it("applies an explicit mode selection while the saved mode is refused", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("auto", "accept-edits", "plan"),
      fc.constantFrom("cold", "idle", "after-refusal"),
      fc.boolean(),
      async (savedMode, activation, chooseDefault) => {
        await withSession(async ({ open, select, store }) => {
          const startup = await open();
          await select(startup.client, savedMode);
          if (activation !== "cold") {
            expect(await startup.client.closeIdleSessions({ idleMs: 0 })).toEqual([sessionId]);
          }
          const { client, transport } = activation === "cold" ? await open() : startup;
          transport.refusedMode = savedMode;
          if (activation === "after-refusal") {
            // The cleanup RPC can also fail. Recovery must still be possible.
            transport.refuseClose = true;
            await expect(client.startPrompt({ sessionId, prompt: "Blocked" })).rejects.toThrow(/restore/);
            transport.refuseClose = false;
          }

          const selectedMode = chooseDefault ? "default" : savedMode === "plan" ? "auto" : "plan";
          const before = transport.requests.length;
          await selectModeThroughOwner(client, store, selectedMode);
          expect(transport.requests.slice(before).filter((entry) => entry.method === "session/set_config_option"))
            .not.toContainEqual(expect.objectContaining({ params: expect.objectContaining({ value: savedMode }) }));
          expect(store.getSession("acp:antigravity", sessionId)?.acpRuntime?.currentModeId).toBe(selectedMode);
          await finishPrompt(client);
          expect(transport.sentPrompts).toEqual([selectedMode]);
        });
      },
    ), { numRuns: 25, examples: [["auto", "idle", true], ["plan", "after-refusal", false]] });
  });

  it.each([false, true])("keeps the last confirmed mode when the explicit replacement is refused (idle closed: %s)", async (idleClosed) => {
    await withSession(async ({ open, select, store }) => {
      const { client, transport } = await open();
      await select(client, "auto");
      if (idleClosed) expect(await client.closeIdleSessions({ idleMs: 0 })).toEqual([sessionId]);
      transport.refusedMode = "plan";
      await expect(selectModeThroughOwner(client, store, "plan")).rejects.toThrow(/apply.*plan/i);
      expect(store.getSession("acp:antigravity", sessionId)?.acpRuntime?.currentModeId).toBe("auto");
      await finishPrompt(client);
      expect(transport.sentPrompts).toEqual(["auto"]);
    });
  });

  it("leaves an unconfirmed worker closed or reachable by archive and idle cleanup", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (refuseCleanup, archive) => {
      await withSession(async ({ open, select }) => {
        const { client, transport } = await open();
        await select(client, "auto");
        expect(await client.closeIdleSessions({ idleMs: 0 })).toEqual([sessionId]);
        transport.refusedMode = "auto";
        transport.refuseClose = refuseCleanup;
        await expect(client.startPrompt({ sessionId, prompt: "Search for the marker" })).rejects.toThrow(/restore.*auto/i);
        expect(transport.sentPrompts).toEqual([]);
        expect(transport.workerOpen).toBe(refuseCleanup);

        transport.refuseClose = false;
        if (archive) expect(await client.closeSessionForArchive(sessionId)).toBe(true);
        else expect(await client.closeIdleSessions({ idleMs: 0 })).toEqual(refuseCleanup ? [sessionId] : []);
        expect(transport.workerOpen).toBe(false);
      });
    }), { numRuns: 25, examples: [[false, true], [true, true], [true, false]] });
  });
});
