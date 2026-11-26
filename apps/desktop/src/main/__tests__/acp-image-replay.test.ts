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
});
