import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
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
  refuseModeWrite = false;

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const result = super.request(method, params, timeoutMs);
    if (method === "session/new" || method === "session/load") {
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
      if (!this.refuseModeWrite) this.mode = String(params.value);
      this.emitSessionUpdate(sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: this.mode,
      });
      return { configOptions: configOptions(this.mode) };
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
      transport.refuseModeWrite = true;
      await expect(client.startPrompt({ sessionId, prompt: "Search for the marker" })).rejects.toThrow(/restore.*auto/i);
      expect(transport.sentPrompts).toEqual([]);
      expect(store.getSession("acp:antigravity", sessionId)?.acpRuntime?.currentModeId).toBe("auto");

      transport.refuseModeWrite = false;
      await finishPrompt(client);
      expect(transport.sentPrompts).toEqual(["auto"]);
    });
  });
});
