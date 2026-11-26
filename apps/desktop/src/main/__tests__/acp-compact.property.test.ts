import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import type {
  AcpBackendId,
  AppServerAvailableCommandSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import { AcpAgentClient } from "../acp/acp-client";
import {
  findAdvertisedAcpCompactCommand,
  formatAcpCompactCommandPrompt,
  isAcpCompactCommandText,
  isAcpCompactPromptBlocks,
  isAcpCompactTurnInput,
} from "../acp/acp-compact";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { buildAcpAgentInstructionBlock } from "../../shared/agent-instruction-delivery";
import {
  createAcpAvailableCommandsStoreMock,
  createAcpSessionStoreMock,
  createKimiAcpRegistry,
  createOverlayStoreMock,
  toTestRepositoryPath,
} from "./helpers/backend-registry-fixture";

vi.mock("../log", () => ({
  getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const ANTIGRAVITY: AcpBackendId = "acp:antigravity";
const SESSION_ID = "antigravity-session-1";
const CWD = "/Users/test/repo";
const INSTRUCTIONS = "Always keep responses terse.";
const MEMORY = "Durable memory note.";

const registries: DesktopBackendRegistry[] = [];
const clients: AcpAgentClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.dispose();
  }
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
});

function sessionFixture(
  overrides: Partial<AcpSessionMetadata> = {},
): AcpSessionMetadata {
  return {
    backendId: ANTIGRAVITY,
    sessionId: SESSION_ID,
    title: "Antigravity thread",
    cwd: CWD,
    createdAt: 1000,
    updatedAt: 1000,
    executionMode: "default",
    status: "idle",
    ...overrides,
  };
}

function createRealAcpClient(options?: {
  session?: AcpSessionMetadata;
  stopReason?: string;
  onSessionUpdate?: (event: { update: Record<string, unknown> }) => void;
}) {
  const transport = new FakeAcpAgentTransport({
    initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    "session/prompt": { stopReason: options?.stopReason ?? "end_turn" },
  });
  const session = options?.session ?? sessionFixture({
    agentSessionId: "proto-session-1",
    agentInstructionsDigest: "prior-digest",
  });
  const store = createAcpSessionStoreMock([session]);
  const client = new AcpAgentClient({
    backendId: ANTIGRAVITY,
    transport,
    store,
    ...(options?.onSessionUpdate ? { onSessionUpdate: options.onSessionUpdate } : {}),
  });
  clients.push(client);
  return { client, store, transport, session };
}

describe("ACP /compact dispatch and wire preservation", () => {
  it("property: advertised compact command discovery matches compact by name or alias regardless of leading slash or case", () => {
    const otherNameArb = fc.constantFrom("plan", "btw", "goal", "clear", "diff", "help", "compact-more");
    const compactVariantArb = fc.constantFrom(
      { name: "compact" },
      { name: "/compact" },
      { name: "COMPACT" },
      { name: "  /CoMpAcT  " },
      { name: "summarize", aliases: ["compact"] },
      { name: "summarize", aliases: ["/COMPACT"] },
    );

    fc.assert(
      fc.property(
        fc.uniqueArray(otherNameArb, { maxLength: 5 }),
        fc.boolean(),
        compactVariantArb,
        (otherNames, includeCompact, compactVariant) => {
          const commands: AppServerAvailableCommandSummary[] = otherNames.map((name) => ({
            name,
            backend: ANTIGRAVITY,
            scope: "session",
            source: "provider",
          }));
          if (includeCompact) {
            commands.push({
              name: compactVariant.name,
              ...(compactVariant.aliases ? { aliases: [...compactVariant.aliases] } : {}),
              backend: ANTIGRAVITY,
              scope: "session",
              source: "provider",
            });
          }

          const found = findAdvertisedAcpCompactCommand(commands);
          if (!includeCompact) {
            expect(found).toBeUndefined();
            return;
          }
          expect(found).toBeDefined();
          const prompt = formatAcpCompactCommandPrompt(found!);
          expect(prompt.startsWith("/")).toBe(true);
          expect(prompt).not.toMatch(/^\/\//);
          expect(prompt.trim()).toBe(prompt);
        },
      ),
    );
  });

  it("property: leading /compact detection accepts bare or whitespace-delimited focus text and rejects non-leading or non-text prompts", () => {
    const leadingWsArb = fc.constantFrom("", " ", "  ", "\n");
    const cmdCaseArb = fc.constantFrom("/compact", "/COMPACT", "/Compact");
    const focusArb = fc.string({ maxLength: 40 });
    const nonLeadingPrefixArb = fc.constantFrom("explain ", "run ", "please ", "foo");

    fc.assert(
      fc.property(leadingWsArb, cmdCaseArb, focusArb, nonLeadingPrefixArb, (ws, cmd, focus, prefix) => {
        const bare = `${ws}${cmd}`;
        const withFocus = `${ws}${cmd} ${focus}`;
        const notCompact = `${prefix}/compact`;
        const prefixedWord = `${ws}${cmd}ion`;

        expect(isAcpCompactCommandText(bare)).toBe(true);
        expect(isAcpCompactCommandText(withFocus)).toBe(true);
        expect(isAcpCompactCommandText(notCompact)).toBe(false);
        expect(isAcpCompactCommandText(prefixedWord)).toBe(false);

        expect(isAcpCompactTurnInput([{ type: "text", text: withFocus }])).toBe(true);
        expect(isAcpCompactTurnInput([{ type: "image", url: "data:image/png;base64,AA==" }, { type: "text", text: bare }])).toBe(false);
        expect(isAcpCompactPromptBlocks([{ type: "text", text: withFocus }])).toBe(true);
        expect(isAcpCompactPromptBlocks([{ type: "image" }, { type: "text", text: bare }])).toBe(false);
      }),
    );
  });

  it("counterexample: Antigravity thread advertising compact dispatches /compact through compactThread", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "compact-turn-1" }));
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        sessionFixture({
          availableCommands: [
            {
              name: "compact",
              description: "Summarize the conversation into a checkpoint.",
              backend: ANTIGRAVITY,
              scope: "session",
              source: "provider",
            },
          ],
        }),
      ],
      startPrompt,
    });
    registries.push(fixture.registry);

    const result = await fixture.registry.compactThread({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
    });

    expect(result).toEqual({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      turnId: "compact-turn-1",
    });
    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        prompt: "/compact",
      }),
    );
  });

  it("rejects compactThread when an ACP backend does not advertise compact", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "compact-turn-1" }));
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        sessionFixture({
          availableCommands: [
            { name: "plan", backend: ANTIGRAVITY, scope: "session", source: "provider" },
          ],
        }),
      ],
      startPrompt,
    });
    registries.push(fixture.registry);

    await expect(
      fixture.registry.compactThread({ backend: ANTIGRAVITY, threadId: SESSION_ID }),
    ).rejects.toThrow(`ACP backend ${ANTIGRAVITY} does not support thread compaction`);
    expect(startPrompt).not.toHaveBeenCalled();
  });

  it("resolves advertised compact from the repo command cache when the session has not advertised yet", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "compact-turn-cache" }));
    const availableCommandsStore = createAcpAvailableCommandsStoreMock([
      {
        backendId: ANTIGRAVITY,
        repositoryPath: toTestRepositoryPath(CWD),
        observedAt: 1000,
        commands: [
          {
            name: "compact",
            backend: ANTIGRAVITY,
            scope: "session",
            source: "provider",
          },
        ],
      },
    ]);
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [sessionFixture()],
      acpAvailableCommandsStore: availableCommandsStore,
      acpWorktreeRepositoryResolver: async () => undefined,
      startPrompt,
    });
    registries.push(fixture.registry);

    const result = await fixture.registry.compactThread({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
    });

    expect(result.turnId).toBe("compact-turn-cache");
    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "/compact" }),
    );
  });

  it("refuses compactThread on a locked ACP thread even when compact is advertised", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "compact-turn-1" }));
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        sessionFixture({
          availableCommands: [
            { name: "compact", backend: ANTIGRAVITY, scope: "session", source: "provider" },
          ],
        }),
      ],
      startPrompt,
    });
    registries.push(fixture.registry);
    await fixture.registry.setThreadLock(
      { backend: ANTIGRAVITY, threadId: SESSION_ID, locked: true, note: "Pinned for review" },
      { source: "operator" },
    );

    await expect(
      fixture.registry.compactThread({ backend: ANTIGRAVITY, threadId: SESSION_ID }),
    ).rejects.toThrow(/locked/i);
    expect(startPrompt).not.toHaveBeenCalled();
  });

  it("refuses compactThread while an ACP turn is already running", async () => {
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "active-turn-1" }));
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        sessionFixture({
          availableCommands: [
            { name: "compact", backend: ANTIGRAVITY, scope: "session", source: "provider" },
          ],
        }),
      ],
      startPrompt,
    });
    registries.push(fixture.registry);

    await fixture.registry.startTurn({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      input: [{ type: "text", text: "In-flight work" }],
    });

    await expect(
      fixture.registry.compactThread({ backend: ANTIGRAVITY, threadId: SESSION_ID }),
    ).rejects.toThrow("Cannot compact a thread while another operation is running");
    expect(startPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not prepend or consume pending managed review context on an ACP /compact turn", async () => {
    const overlayStore = createOverlayStoreMock();
    await overlayStore.upsertManagedReviewEntry({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
      entry: {
        id: "review-1",
        type: "review",
        createdAt: 1000,
        review: "Fix null dereference in foo.ts",
        status: "completed",
      },
      pendingContext: true,
    });
    const startPrompt = vi.fn(() => ({ sessionId: SESSION_ID, turnId: "compact-turn-1" }));
    const fixture = createKimiAcpRegistry({
      acpBackendId: ANTIGRAVITY,
      sessionId: SESSION_ID,
      sessions: [
        sessionFixture({
          availableCommands: [
            { name: "compact", backend: ANTIGRAVITY, scope: "session", source: "provider" },
          ],
        }),
      ],
      overlayStore,
      startPrompt,
    });
    registries.push(fixture.registry);

    await fixture.registry.compactThread({ backend: ANTIGRAVITY, threadId: SESSION_ID });

    expect(startPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "/compact" }),
    );
    const overlayAfter = await overlayStore.getThreadOverlayState({
      backend: ANTIGRAVITY,
      threadId: SESSION_ID,
    });
    expect(overlayAfter?.pendingManagedReviewContextEntryIds).toEqual(["review-1"]);
  });

  it("keeps leading /compact as prompt[0] without instructions, memory, or workspace context", async () => {
    for (const text of ["/compact", "/COMPACT", "/compact Keep OAuth findings and add tests."]) {
      const { client, store, transport } = createRealAcpClient({
        session: sessionFixture({
          agentSessionId: "proto-session-1",
          agentInstructionsDigest: undefined,
          antigravityWorkspaceRebound: true,
        }),
      });
      await client.initialize();
      await client.startPrompt({
        sessionId: SESSION_ID,
        prompt: text,
        agentInstructions: INSTRUCTIONS,
        readAgentMemory: async () => MEMORY,
      });
      await vi.waitFor(() => {
        expect(
          transport.requests.some((request) => request.method === "session/prompt"),
        ).toBe(true);
      });

      const promptRequest = transport.requests.find(
        (request) => request.method === "session/prompt",
      );
      const sentBlocks = promptRequest?.params?.prompt as Array<{
        type: string;
        text?: string;
      }>;
      expect(sentBlocks).toEqual([{ type: "text", text }]);
      expect(JSON.stringify(sentBlocks)).not.toContain(
        buildAcpAgentInstructionBlock(INSTRUCTIONS),
      );
      expect(JSON.stringify(sentBlocks)).not.toContain(MEMORY);

      await vi.waitFor(() => {
        expect(store.getSession(ANTIGRAVITY, SESSION_ID)?.status).toBe("idle");
      });
      expect(
        store.getSession(ANTIGRAVITY, SESSION_ID)?.antigravityWorkspaceContextDelivered,
      ).toBeUndefined();
      expect(
        store.getSession(ANTIGRAVITY, SESSION_ID)?.agentInstructionsDigest,
      ).toBeUndefined();
      client.dispose();
    }
  });

  it("allows bare /compact to finish cleanly without assistant text", async () => {
    const updates: Array<{ kind?: string }> = [];
    const { client, store } = createRealAcpClient({
      stopReason: "end_turn",
      onSessionUpdate: (event) => {
        updates.push(event.update as { kind?: string });
      },
    });
    await client.initialize();

    await client.startPrompt({
      sessionId: SESSION_ID,
      prompt: "/compact",
    });

    await vi.waitFor(() => {
      expect(store.getSession(ANTIGRAVITY, SESSION_ID)?.status).toBe("idle");
    });
    expect(updates.some((update) => update.kind === "turn_finished")).toBe(true);
    expect(updates.some((update) => update.kind === "turn_failed")).toBe(false);
  });

  it("clears delivered agent instructions after a completed /compact so the next turn re-delivers them, but preserves them on cancel", async () => {
    const completed = createRealAcpClient({ stopReason: "end_turn" });
    await completed.client.initialize();
    await completed.client.startPrompt({
      sessionId: SESSION_ID,
      prompt: "/compact",
      agentInstructions: INSTRUCTIONS,
    });
    await vi.waitFor(() => {
      expect(completed.store.getSession(ANTIGRAVITY, SESSION_ID)?.status).toBe("idle");
    });
    expect(
      completed.store.getSession(ANTIGRAVITY, SESSION_ID)?.agentInstructionsDigest,
    ).toBeUndefined();

    const cancelled = createRealAcpClient({ stopReason: "cancelled" });
    await cancelled.client.initialize();
    await cancelled.client.startPrompt({
      sessionId: SESSION_ID,
      prompt: "/compact",
      agentInstructions: INSTRUCTIONS,
    });
    await vi.waitFor(() => {
      expect(cancelled.store.getSession(ANTIGRAVITY, SESSION_ID)?.status).toBe("idle");
    });
    expect(
      cancelled.store.getSession(ANTIGRAVITY, SESSION_ID)?.agentInstructionsDigest,
    ).toBe("prior-digest");
  });

  it("still delivers agent instructions and memory on non-compact prompts mentioning /compact", async () => {
    const { client, transport } = createRealAcpClient({
      session: sessionFixture({
        agentSessionId: "proto-session-1",
        agentInstructionsDigest: undefined,
      }),
    });
    await client.initialize();
    await client.startPrompt({
      sessionId: SESSION_ID,
      prompt: "explain /compact behavior",
      agentInstructions: INSTRUCTIONS,
      readAgentMemory: async () => MEMORY,
    });
    await vi.waitFor(() => {
      expect(
        transport.requests.some((request) => request.method === "session/prompt"),
      ).toBe(true);
    });
    const promptRequest = transport.requests.find(
      (request) => request.method === "session/prompt",
    );
    const sentBlocks = promptRequest?.params?.prompt as Array<{
      type: string;
      text?: string;
    }>;
    expect(sentBlocks.length).toBe(3);
    expect(sentBlocks[0]?.text).toContain(INSTRUCTIONS);
    expect(sentBlocks[1]?.text).toBe("explain /compact behavior");
    expect(sentBlocks[2]?.text).toBe(MEMORY);
  });
});
