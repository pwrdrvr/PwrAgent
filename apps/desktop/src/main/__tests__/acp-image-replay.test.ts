import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inputToAcpPrompt } from "../app-server/acp-backend-adapter";
import { threadAssetRoot } from "../app-server/thread-assets";
import { ownThreadInputAttachments } from "../app-server/turn-input-attachment-files";
import { AcpAgentClient } from "../acp/acp-client";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
import { acpReplayPromptTextDigest } from "../acp/acp-session-normalizer";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { AcpSessionStore } from "../storage/acp-session-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let testRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-image-replay-"));
  vi.stubEnv("PWRAGENT_HOME", testRoot);
  vi.stubEnv("PWRAGENT_PROFILE", "default");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(testRoot, { recursive: true, force: true });
});

describe("ACP image storage and session/load replay integration", () => {
  it("stores ACP pasted PNG images as thread-owned local files instead of base64 in replay parts", async () => {
    const owner = { backend: "acp:antigravity" as const, threadId: "thread-no-b64" };
    const pngBytes = Buffer.concat([PNG_HEADER, Buffer.from("fake-png-payload")]);
    const dataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;

    const owned = await ownThreadInputAttachments([
      { type: "text", text: "Check this screenshot" },
      { type: "image", name: "PwrSnap-electron-high.png", url: dataUrl },
    ], owner);

    expect(owned[1]).toMatchObject({
      type: "localImage",
      name: "PwrSnap-electron-high.png",
    });

    const payload = await inputToAcpPrompt(owned, { owner, privateStorageRoots: [] });
    expect(payload).toBeDefined();
    const imageParts = payload!.parts.filter((part) => part.type === "image");
    expect(imageParts).toHaveLength(1);
    const imageUrl = imageParts[0]!.url;
    expect(imageUrl.startsWith("pwragent-image://file/")).toBe(true);
    expect(imageUrl).not.toContain("data:");
    const assetPath = fileURLToPath(decodeURIComponent(imageUrl.slice("pwragent-image://file/".length)));
    expect(assetPath.startsWith(threadAssetRoot(owner))).toBe(true);
    await expect(readFile(assetPath)).resolves.toEqual(pngBytes);

    // Wire prompt still carries ACP-spec base64 ImageContent for the provider.
    expect(payload!.promptContent).toContainEqual({
      type: "image",
      mimeType: "image/png",
      data: pngBytes.toString("base64"),
    });
  });

  it("reproduces the split Attached image filename bubble and missing image from b50135af on session/load", async () => {
    const stateDb = openInMemoryStateDb();
    const sessionStore = new AcpSessionStore(stateDb);
    const rolloutStore = new AcpRolloutStore(path.join(testRoot, "rollouts"));
    const sessionId = "b50135af-c444-4f9e-a282-84879974c664";
    const promptText =
      "Ok, so it's 2 submodules correctly configured (and hopefully cloned?) and 2 unconfigured?";
    const imageUrl = "pwragent-image://file/%2Ftmp%2FPwrSnap-electron-high.png";

    rolloutStore.appendUpdate({
      backendId: "acp:antigravity",
      sessionId,
      receivedAt: 1_795_619_460_772,
      update: {
        kind: "pwragent_user_prompt",
        prompt: promptText,
        parts: [
          { type: "text", text: promptText },
          { type: "image", alt: "PwrSnap-electron-high.png", url: imageUrl },
        ],
        turnId: `pending:${sessionId}:1795619460771`,
        waitingForAgent: true,
      },
    });
    sessionStore.upsertSession({
      backendId: "acp:antigravity",
      sessionId,
      title: "T3Code Submodule Warnings Analysis",
      cwd: testRoot,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
      createdAt: 1_795_619_460_772,
      updatedAt: 1_795_619_500_916,
    });

    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/load") {
        const reloadTs = 1_795_655_160_000;
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: promptText },
          timestamp: reloadTs,
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Attached image filename: PwrSnap-electron-high.png" },
          timestamp: reloadTs,
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "No — t3code has 0 configured submodules." },
          timestamp: reloadTs + 1000,
        });
        return {};
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store: sessionStore,
      rolloutStore,
      transport,
    });

    try {
      await client.initialize();
      const replay = await client.loadSession(sessionStore.getSession("acp:antigravity", sessionId)!);
      const userMessages = replay.messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.text).toBe(promptText);
      expect(userMessages[0]?.parts).toEqual([
        { type: "text", text: promptText },
        { type: "image", alt: "PwrSnap-electron-high.png", url: imageUrl },
      ]);
    } finally {
      await client.dispose();
      stateDb.close();
    }
  });

  it.each(["acp:antigravity", "acp:grok"] as const)(
    "retains lightweight image attachment refs across restart after verified %s provider replay",
    async (backendId) => {
      const stateDb = openInMemoryStateDb();
      const sessionStore = new AcpSessionStore(stateDb);
      const rolloutStore = new AcpRolloutStore(path.join(testRoot, "rollouts-post-verify"));
      const sessionId = `session-${backendId.replace(":", "-")}`;
      const imageUrl = "pwragent-image://file/%2Ftmp%2Fafter-verify.png";

      sessionStore.upsertSession({
        backendId,
        sessionId,
        title: "Post-verify image session",
        cwd: testRoot,
        executionMode: "default",
        status: "idle",
        hasConversationHistory: true,
        createdAt: 1_795_600_000_000,
        updatedAt: 1_795_600_000_000,
      });

      const replayedPrompts: Array<{ text: string; filename?: string; ts: number }> = [
        { text: "Earlier turn", ts: 1_795_600_000_000 },
      ];

      const makeTransport = () => {
        const transport = new FakeAcpAgentTransport({
          initialize: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          },
        });
        const baseRequest = transport.request.bind(transport);
        transport.request = async (method, params, timeoutMs) => {
          if (method === "session/load") {
            for (const item of replayedPrompts) {
              transport.emitSessionUpdate(sessionId, {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: item.text },
                timestamp: item.ts,
              });
              if (item.filename) {
                transport.emitSessionUpdate(sessionId, {
                  sessionUpdate: "user_message_chunk",
                  content: { type: "text", text: `[Local image: ${item.filename}]` },
                  timestamp: item.ts,
                });
              }
              transport.emitSessionUpdate(sessionId, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Answer to ${item.text}` },
                timestamp: item.ts + 1000,
              });
            }
            return {};
          }
          if (method === "session/prompt") {
            replayedPrompts.push({
              text: "Follow-up with image",
              filename: "after-verify.png",
              ts: 1_795_600_100_000,
            });
            transport.emitSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Answer to Follow-up with image" },
              timestamp: 1_795_600_101_000,
            });
            return { stopReason: "end_turn" };
          }
          return await baseRequest(method, params, timeoutMs);
        };
        return transport;
      };

      const client1 = new AcpAgentClient({
        backendId,
        store: sessionStore,
        rolloutStore,
        transport: makeTransport(),
      });
      try {
        await client1.initialize();
        await client1.loadSession(sessionStore.getSession(backendId, sessionId)!);
        await client1.prompt({
          sessionId,
          prompt: "Follow-up with image",
          promptContent: [
            { type: "text", text: "Follow-up with image" },
            { type: "text", text: "[Local image: after-verify.png]" },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
          parts: [
            { type: "text", text: "Follow-up with image" },
            { type: "image", alt: "after-verify.png", url: imageUrl },
          ],
        });
      } finally {
        await client1.dispose();
      }

      // Ensure no raw prompt text or base64 was persisted after verified replay.
      const savedRecords = rolloutStore.readUpdates({ backendId, sessionId });
      expect(savedRecords.length).toBeGreaterThan(0);
      expect(JSON.stringify(savedRecords)).not.toContain("Follow-up with image");
      expect(JSON.stringify(savedRecords)).not.toContain("data:image");

      const client2 = new AcpAgentClient({
        backendId,
        store: sessionStore,
        rolloutStore,
        transport: makeTransport(),
      });
      try {
        await client2.initialize();
        const replay = await client2.loadSession(sessionStore.getSession(backendId, sessionId)!);
        const userMessages = replay.messages.filter((m) => m.role === "user");
        expect(userMessages.map((m) => m.text)).toEqual(["Earlier turn", "Follow-up with image"]);
        expect(userMessages[1]?.parts).toEqual([
          { type: "text", text: "Follow-up with image" },
          { type: "image", alt: "after-verify.png", url: imageUrl },
        ]);
      } finally {
        await client2.dispose();
        stateDb.close();
      }
    },
  );

  it("does not duplicate user prompts or mutate fallbackNormalizer on incomplete non-Antigravity session/load", async () => {
    const stateDb = openInMemoryStateDb();
    const sessionStore = new AcpSessionStore(stateDb);
    const rolloutStore = new AcpRolloutStore(path.join(testRoot, "rollouts-incomplete-grok"));
    const backendId = "acp:grok" as const;
    const sessionId = "grok-incomplete-image";
    const imageUrl = "pwragent-image://file/%2Ftmp%2Finterrupted.png";

    // Incomplete rollout: user sent a prompt with an image, turn never finished (threadStatus = "active").
    rolloutStore.appendUpdate({
      backendId,
      sessionId,
      receivedAt: 1_795_600_000_000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "Inspect this interrupted turn",
        parts: [
          { type: "text", text: "Inspect this interrupted turn" },
          { type: "image", alt: "interrupted.png", url: imageUrl },
        ],
        turnId: "turn-interrupted",
        waitingForAgent: true,
      },
    });
    sessionStore.upsertSession({
      backendId,
      sessionId,
      title: "Interrupted Grok session",
      cwd: testRoot,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
      createdAt: 1_795_600_000_000,
      updatedAt: 1_795_600_000_000,
    });

    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/load") {
        // Provider replays without timestamps (reload-time receivedAt differs from local receivedAt).
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Inspect this interrupted turn" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Attached image filename: interrupted.png" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Recovered response" },
        });
        return {};
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const client = new AcpAgentClient({
      backendId,
      store: sessionStore,
      rolloutStore,
      transport,
    });
    try {
      await client.initialize();
      const replay = await client.loadSession(sessionStore.getSession(backendId, sessionId)!);
      const userMessages = replay.messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.text).toBe("Inspect this interrupted turn");
      expect(userMessages[0]?.parts).toEqual([
        { type: "text", text: "Inspect this interrupted turn" },
        { type: "image", alt: "interrupted.png", url: imageUrl },
      ]);
    } finally {
      await client.dispose();
      stateDb.close();
    }
  });

  it("preserves steered and initial images when a cold client loads via ensureSession (3d87f59a regression)", async () => {
    const stateDb = openInMemoryStateDb();
    const sessionStore = new AcpSessionStore(stateDb);
    const rolloutStore = new AcpRolloutStore(path.join(testRoot, "rollouts-ensure-session"));
    const sessionId = "3d87f59a-6176-44e1-8768-f9c7f8bbaee4";
    const initialText = "It looks like Antigravity gave us a rate limit reset?";
    const steerText = "By the way I confirmed they did reset the usage limits about 6 hours ago.";
    const initialImageUrl = "pwragent-image://file/%2Ftmp%2FPwrSnap-pwragent-high.png";
    const steerImageUrl = "pwragent-image://file/%2Ftmp%2Fimage.png";

    rolloutStore.appendUpdate({
      backendId: "acp:antigravity",
      sessionId,
      receivedAt: 1_795_700_641_340,
      update: {
        kind: "pwragent_user_prompt",
        prompt: initialText,
        parts: [
          { type: "text", text: initialText },
          { type: "image", alt: "PwrSnap-pwragent-high.png", url: initialImageUrl },
        ],
        turnId: `pending:${sessionId}:1795700641339`,
        waitingForAgent: true,
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:antigravity",
      sessionId,
      receivedAt: 1_795_701_852_855,
      update: {
        kind: "pwragent_steered_user_prompt",
        messageId: `user:pending:${sessionId}:1795700641339:steer:queued-turn-1`,
        prompt: steerText,
        parts: [
          { type: "text", text: steerText },
          { type: "image", alt: "image.png", url: steerImageUrl },
        ],
        turnId: `pending:${sessionId}:1795700641339`,
        createdAt: 1_795_701_852_855,
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:antigravity",
      sessionId,
      receivedAt: 1_795_702_203_263,
      update: {
        kind: "turn_finished",
        turnId: `pending:${sessionId}:1795700641339`,
        outputText: "All tests passed.",
      },
    });
    sessionStore.upsertSession({
      backendId: "acp:antigravity",
      sessionId,
      title: "Fixing Antigravity Rate Limit Issues",
      cwd: testRoot,
      executionMode: "full-access",
      status: "idle",
      hasConversationHistory: true,
      createdAt: 1_795_700_641_340,
      updatedAt: 1_795_702_203_263,
    });

    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/load") {
        // Antigravity replays tool calls with historical timestamps, user chunks without timestamps
        // (receiving reload-time receivedAt = 9:28 AM) and omits image binary blocks.
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: initialText },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Attached image filename: PwrSnap-pwragent-high.png" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Edited usage-limits-mbt-discovery.test.ts",
          status: "completed",
          timestamp: 1_795_701_840_000,
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: steerText },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Attached image filename: image.png" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "All tests passed." },
          timestamp: 1_795_702_203_263,
        });
        return {};
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store: sessionStore,
      rolloutStore,
      transport,
      now: () => 1_795_703_298_419,
    });
    try {
      await client.initialize();
      const session = sessionStore.getSession("acp:antigravity", sessionId)!;
      // Simulates prepareSessionEnvironment / startAcpTurnLocked on a cold client.
      await client.ensureSession(session);
      const memoryReplay = client.readReplay(sessionId);
      const loadedReplay = await client.loadSession(session);

      for (const replay of [memoryReplay, loadedReplay]) {
        const userMessages = replay.messages.filter((m) => m.role === "user");
        expect(userMessages.map((m) => m.text)).toEqual([initialText, steerText]);
        expect(userMessages[0]?.parts).toEqual([
          { type: "text", text: initialText },
          { type: "image", alt: "PwrSnap-pwragent-high.png", url: initialImageUrl },
        ]);
        expect(userMessages[1]?.parts).toEqual([
          { type: "text", text: steerText },
          { type: "image", alt: "image.png", url: steerImageUrl },
        ]);
      }
    } finally {
      await client.dispose();
      stateDb.close();
    }
  });

  it("persists Grok steered image attachment metadata so reload restores the steered image", async () => {
    const stateDb = openInMemoryStateDb();
    const sessionStore = new AcpSessionStore(stateDb);
    const rolloutStore = new AcpRolloutStore(path.join(testRoot, "rollouts-grok-steer"));
    const sessionId = "grok-steer-image-session";
    const steerImageUrl = "pwragent-image://file/%2Ftmp%2Fgrok-steer.png";
    const history: Array<{ text: string; annotation?: string; reply: string; ts: number }> = [];
    let holdPrompt: ((value: unknown) => void) | undefined;

    const makeTransport = () => {
      const transport = new FakeAcpAgentTransport({
        initialize: {
          protocolVersion: 1,
          agentInfo: { name: "grok", version: "1.0.45-pwragent.2" },
          agentCapabilities: { loadSession: true },
        },
      });
      const baseRequest = transport.request.bind(transport);
      transport.request = async (method, params, timeoutMs) => {
        if (method === "session/new") return { sessionId };
        if (method === "session/prompt") {
          history.push({ text: "Initial task", reply: "Working...", ts: 1_795_700_000_000 });
          transport.emitSessionUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Working..." },
            timestamp: 1_795_700_000_500,
          });
          return await new Promise((resolve) => {
            holdPrompt = resolve;
          });
        }
        if (method === "_x.ai/session/steer") {
          history.push({
            text: "Use this layout",
            annotation: "[Local image: grok-steer.png]",
            reply: "Updated layout.",
            ts: 1_795_700_010_000,
          });
          setTimeout(() => {
            transport.emitSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Updated layout." },
              timestamp: 1_795_700_011_000,
            });
            holdPrompt?.({ stopReason: "end_turn" });
            holdPrompt = undefined;
          }, 0);
          return { delivery: "currentTurn" };
        }
        if (method === "session/load") {
          for (const turn of history) {
            transport.emitSessionUpdate(sessionId, {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: turn.text },
              timestamp: turn.ts,
            });
            if (turn.annotation) {
              transport.emitSessionUpdate(sessionId, {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: turn.annotation },
                timestamp: turn.ts,
              });
            }
            transport.emitSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: turn.reply },
              timestamp: turn.ts + 500,
            });
          }
          return {};
        }
        return await baseRequest(method, params, timeoutMs);
      };
      return transport;
    };

    const client1 = new AcpAgentClient({
      backendId: "acp:grok",
      store: sessionStore,
      rolloutStore,
      transport: makeTransport(),
    });
    let turnDone = Promise.withResolvers<void>();
    try {
      await client1.initialize();
      await client1.startSession({
        sessionId,
        cwd: testRoot,
        title: "Grok steer image",
        executionMode: "default",
      });
      await client1.startPrompt({
        sessionId,
        prompt: "Initial task",
        promptContent: [{ type: "text", text: "Initial task" }],
        parts: [{ type: "text", text: "Initial task" }],
      });
      await client1.steerSession({
        sessionId,
        text: "Use this layout",
        prompt: "Use this layout",
        parts: [
          { type: "text", text: "Use this layout" },
          { type: "image", alt: "grok-steer.png", url: steerImageUrl },
        ],
        content: [
          { type: "text", text: "Use this layout" },
          { type: "text", text: "[Local image: grok-steer.png]" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
        interjectionId: "steer-img-1",
      });
      await new Promise((r) => setTimeout(r, 20));
      turnDone.resolve();
    } finally {
      await client1.dispose();
    }

    const client2 = new AcpAgentClient({
      backendId: "acp:grok",
      store: sessionStore,
      rolloutStore,
      transport: makeTransport(),
    });
    try {
      await client2.initialize();
      const replay = await client2.loadSession(sessionStore.getSession("acp:grok", sessionId)!);
      const userMessages = replay.messages.filter((m) => m.role === "user");
      expect(userMessages.map((m) => m.text)).toEqual(["Initial task", "Use this layout"]);
      expect(userMessages[1]?.parts).toEqual([
        { type: "text", text: "Use this layout" },
        { type: "image", alt: "grok-steer.png", url: steerImageUrl },
      ]);
    } finally {
      await client2.dispose();
      stateDb.close();
    }
  });

  it("does not drop post-verified image turns when a subsequent session/load omits timestamps", async () => {
    const stateDb = openInMemoryStateDb();
    const sessionStore = new AcpSessionStore(stateDb);
    const rolloutStore = new AcpRolloutStore(path.join(testRoot, "rollouts-post-verified-untimed"));
    const sessionId = "post-verified-untimed";
    const imageUrl = "pwragent-image://file/%2Ftmp%2Fturn2.png";

    // Turn 1 recorded before verified replay (complete idle rollout).
    rolloutStore.appendUpdate({
      backendId: "acp:antigravity",
      sessionId,
      receivedAt: 1_795_600_000_000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "First turn",
        parts: [{ type: "text", text: "First turn" }],
        turnId: "turn-1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:antigravity",
      sessionId,
      receivedAt: 1_795_600_001_000,
      update: {
        kind: "turn_finished",
        turnId: "turn-1",
        outputText: "First reply",
      },
    });
    // Turn 2 recorded after verified replay (identity + attachment metadata only).
    rolloutStore.appendUpdate({
      backendId: "acp:antigravity",
      sessionId,
      receivedAt: 1_795_600_100_000,
      update: {
        kind: "pwragent_antigravity_prompt_identity",
        turnId: "turn-2",
        textDigest: acpReplayPromptTextDigest("Second turn"),
        attachmentParts: [{ type: "image", alt: "turn2.png", url: imageUrl }],
      },
    });
    sessionStore.upsertSession({
      backendId: "acp:antigravity",
      sessionId,
      title: "Post-verified untimed",
      cwd: testRoot,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
      createdAt: 1_795_600_000_000,
      updatedAt: 1_795_600_100_000,
    });

    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/load") {
        // Provider replays both turns WITHOUT timestamps.
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "First turn" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "First reply" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Second turn" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "[Local image: turn2.png]" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Second reply" },
        });
        return {};
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store: sessionStore,
      rolloutStore,
      transport,
    });
    try {
      await client.initialize();
      const replay = await client.loadSession(sessionStore.getSession("acp:antigravity", sessionId)!);
      const userMessages = replay.messages.filter((m) => m.role === "user");
      expect(userMessages.map((m) => m.text)).toEqual(["First turn", "Second turn"]);
      expect(userMessages[1]?.parts).toEqual([
        { type: "text", text: "Second turn" },
        { type: "image", alt: "turn2.png", url: imageUrl },
      ]);
    } finally {
      await client.dispose();
      stateDb.close();
    }
  });

  it("does not duplicate earlier turns on an incomplete multi-turn Grok rollout with images", async () => {
    const stateDb = openInMemoryStateDb();
    const sessionStore = new AcpSessionStore(stateDb);
    const rolloutStore = new AcpRolloutStore(path.join(testRoot, "rollouts-incomplete-multi-grok"));
    const sessionId = "grok-incomplete-multi";
    const img1 = "pwragent-image://file/%2Ftmp%2Ffirst.png";
    const img2 = "pwragent-image://file/%2Ftmp%2Fsecond.png";

    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId,
      receivedAt: 1_795_600_000_000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "First",
        parts: [{ type: "text", text: "First" }, { type: "image", alt: "first.png", url: img1 }],
        turnId: "turn-1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId,
      receivedAt: 1_795_600_001_000,
      update: {
        kind: "turn_finished",
        turnId: "turn-1",
        outputText: "Reply 1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId,
      receivedAt: 1_795_600_010_000,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "Second",
        parts: [{ type: "text", text: "Second" }, { type: "image", alt: "second.png", url: img2 }],
        turnId: "turn-2",
        waitingForAgent: true,
      },
    });
    sessionStore.upsertSession({
      backendId: "acp:grok",
      sessionId,
      title: "Multi-turn interrupted Grok",
      cwd: testRoot,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
      createdAt: 1_795_600_000_000,
      updatedAt: 1_795_600_010_000,
    });

    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/load") {
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "First" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "[Local image: first.png]" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Reply 1" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Second" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "[Local image: second.png]" },
        });
        transport.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Reply 2" },
        });
        return {};
      }
      return await baseRequest(method, params, timeoutMs);
    };

    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store: sessionStore,
      rolloutStore,
      transport,
    });
    try {
      await client.initialize();
      const replay = await client.loadSession(sessionStore.getSession("acp:grok", sessionId)!);
      const userMessages = replay.messages.filter((m) => m.role === "user");
      expect(userMessages.map((m) => m.text)).toEqual(["First", "Second"]);
      expect(userMessages[0]?.parts).toEqual([
        { type: "text", text: "First" },
        { type: "image", alt: "first.png", url: img1 },
      ]);
      expect(userMessages[1]?.parts).toEqual([
        { type: "text", text: "Second" },
        { type: "image", alt: "second.png", url: img2 },
      ]);
    } finally {
      await client.dispose();
      stateDb.close();
    }
  });
});
