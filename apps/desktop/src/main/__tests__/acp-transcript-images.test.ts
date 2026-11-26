import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AcpBackendId,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  AcpBackendAdapter,
  type AcpSessionMetadata,
} from "../app-server/acp-backend-adapter";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import {
  materializeTranscriptImageEventForRenderer,
  materializeTranscriptImageUrlsForRenderer,
} from "../transcript-images";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tAAAAABJRU5ErkJggg==",
  "base64",
);

function buildAgent(backendId: AcpBackendId): AcpInstalledAgentRecord {
  const registryId = backendId.replace(/^acp:/, "");
  return {
    backendId,
    registryId,
    name: registryId,
    version: "1.0.0",
    distribution: "npx",
    installStatus: "installed",
    authStatus: "authenticated",
    installedAt: 1,
    updatedAt: 1,
    launchDescriptor: {
      backendId,
      registryId,
      distributionKind: "local",
      command: "fake-acp",
      args: [],
      env: {},
    },
  } as unknown as AcpInstalledAgentRecord;
}

function createHarness(backendId: AcpBackendId, promptResult: Promise<unknown>) {
  const transport = new FakeAcpAgentTransport({ "session/prompt": promptResult });
  const events: AgentEvent[] = [];
  const sessions = new Map<string, AcpSessionMetadata>();
  const agent = buildAgent(backendId);
  const adapter = new AcpBackendAdapter({
    captureStores: [],
    discoverLocalAcpAgents: async () => [agent],
    acpAgentStore: {
      getInstalledAgent: (id) => (id === backendId ? agent : undefined),
      listInstalledAgents: () => [agent],
      upsertInstalledAgent: () => {},
    },
    acpSessionStore: {
      getSession: (_b, id) => sessions.get(id),
      listSessions: () => [...sessions.values()],
      listBackendIds: () => [backendId],
      upsertSession: (session) => { sessions.set(session.sessionId, session); },
    },
    createAcpTransport: () => transport,
    emit: async (event) => {
      events.push(event);
    },
    handleServerRequest: async () => ({ decision: "accept" }),
  });
  return { adapter, events, transport };
}

describe("ACP transcript image live completion and replay parity", () => {
  it("emits item/completed for ACP assistant messages at mid-turn boundaries and turn end, caching /tmp screenshots live", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-img-"));
    const worktreeDir = path.join(tempDir, "worktree");
    const cacheDir = path.join(tempDir, "cache");
    const tmpShotDir = await mkdtemp(path.join(path.sep === "/" ? "/tmp" : os.tmpdir(), "pwragent-acp-shot-"));
    await mkdir(worktreeDir, { recursive: true });

    let resolvePrompt!: (value: unknown) => void;
    const { adapter, events, transport } = createHarness(
      "acp:antigravity",
      new Promise((resolve) => { resolvePrompt = resolve; }),
    );

    try {
      const windowShot = path.join(tmpShotDir, "research-2-running-window.png");
      const panelShot = path.join(tmpShotDir, "research-2-running-panel.png");
      await writeFile(windowShot, TINY_PNG);
      await writeFile(panelShot, TINY_PNG);

      const client = await adapter.getClient("acp:antigravity");
      const session = await client.startSession({ cwd: worktreeDir, executionMode: "default" });
      const promptPromise = client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Capture screenshots",
        turnId: "turn-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: [
            "Captured the Running screenshots:",
            `- Research tracker window: [research-2-running-window.png](${pathToFileURL(windowShot).toString()})`,
            `- Sidebar Research panel: [research-2-running-panel.png](${pathToFileURL(panelShot).toString()})`,
          ].join("\n"),
        },
      });
      // A steer or tool call closes the first assistant bubble mid-turn.
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "pwragent_steered_user_prompt",
        prompt: "Continue watching",
        messageId: "steer-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const midTurnCompletions = events.filter(
        (event) => event.notification.method === "item/completed"
          && (event.notification.params as { item?: { type?: string } }).item?.type === "agentMessage",
      );
      expect(midTurnCompletions).toHaveLength(1);

      const deps = {
        resolveRoot: () => cacheDir,
        retainLocalImage: async () => undefined,
      };
      const materializedLive = await materializeTranscriptImageEventForRenderer(
        midTurnCompletions[0]!,
        deps,
        { approvedLocalImageRoots: [worktreeDir], includeTemporaryImageRoots: true },
      );
      expect(materializedLive.rendererImageParts?.map((img) => img.sourceUrl)).toEqual([
        pathToFileURL(windowShot).toString(),
        pathToFileURL(panelShot).toString(),
      ]);

      // Finish the turn after a second assistant message and delete /tmp sources.
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "All done." },
      });
      resolvePrompt({ stopReason: "end_turn" });
      await promptPromise;
      await new Promise((resolve) => setTimeout(resolve, 5));

      const allAssistantCompletions = events.filter(
        (event) => event.notification.method === "item/completed"
          && (event.notification.params as { item?: { type?: string } }).item?.type === "agentMessage",
      );
      expect(allAssistantCompletions).toHaveLength(2);

      // Even after /tmp screenshots are swept, replay reuses the live-cached files.
      await rm(tmpShotDir, { recursive: true, force: true });
      const replayed = await materializeTranscriptImageUrlsForRenderer(
        {
          backend: "acp:antigravity",
          threadId: session.sessionId,
          fetchedAt: 1,
          replay: client.readReplay(session.sessionId),
        },
        deps,
        { approvedLocalImageRoots: [worktreeDir], includeTemporaryImageRoots: true },
      );
      const firstAssistant = replayed.replay.entries.find(
        (entry): entry is AppServerThreadMessageEntry =>
          entry.type === "message" && entry.role === "assistant",
      );
      const replayImages = (firstAssistant?.parts ?? []).filter(
        (part): part is AppServerThreadImagePart => part.type === "image",
      );
      expect(replayImages).toEqual(materializedLive.rendererImageParts);
    } finally {
      await adapter.close();
      await rm(tempDir, { recursive: true, force: true });
      await rm(tmpShotDir, { recursive: true, force: true });
    }
  });

  it("preserves ACP assistant image content blocks and tool-result images in live events and replay", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-blocks-"));
    let resolvePrompt!: (value: unknown) => void;
    const { adapter, events, transport } = createHarness(
      "acp:antigravity",
      new Promise((resolve) => { resolvePrompt = resolve; }),
    );

    try {
      const client = await adapter.getClient("acp:antigravity");
      const session = await client.startSession({ cwd: tempDir, executionMode: "default" });
      const promptPromise = client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Take a screenshot",
        turnId: "turn-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const pwrSnapUri = "pwrsnap://capture/cap_acp_tool/composite";
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "snap-1",
        kind: "other",
        title: "pwrsnap_capture",
        status: "completed",
        content: [
          { type: "resource_link", uri: pwrSnapUri, mimeType: "image/png", name: "capture.png" },
        ],
      });
      // Image-only assistant response (no text) must not fail as an empty turn.
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          mimeType: "image/png",
          data: TINY_PNG.toString("base64"),
        },
      });
      resolvePrompt({ stopReason: "end_turn" });
      await promptPromise;
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(events.some((event) => event.notification.method === "turn/failed")).toBe(false);
      const toolEvent = events.find(
        (event) => event.notification.method === "item/completed"
          && (event.notification.params as { item?: { id?: string } }).item?.id === "snap-1",
      );
      expect((toolEvent?.notification.params as { item?: { images?: unknown[] } } | undefined)?.item?.images).toEqual([
        { type: "image", url: pwrSnapUri, alt: "capture.png" },
      ]);

      const assistantEvent = events.find(
        (event) => event.notification.method === "item/completed"
          && (event.notification.params as { item?: { type?: string } }).item?.type === "agentMessage",
      );
      expect((assistantEvent?.notification.params as { item?: { content?: unknown[] } } | undefined)?.item?.content).toEqual([
        { type: "image", url: `data:image/png;base64,${TINY_PNG.toString("base64")}` },
      ]);

      const replay = client.readReplay(session.sessionId);
      const activity = replay.entries.find((entry) => entry.type === "activity" && entry.id === "snap-1");
      expect(activity?.type === "activity" ? activity.details[0]?.images : undefined).toEqual([
        { type: "image", url: pwrSnapUri, alt: "capture.png" },
      ]);
      const assistant = replay.entries.find(
        (entry): entry is AppServerThreadMessageEntry =>
          entry.type === "message" && entry.role === "assistant",
      );
      expect(assistant?.parts).toEqual([
        { type: "image", url: `data:image/png;base64,${TINY_PNG.toString("base64")}` },
      ]);
    } finally {
      await adapter.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits item/completed for an in-progress ACP assistant message when the turn fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-err-"));
    let rejectPrompt!: (error: Error) => void;
    const { adapter, events, transport } = createHarness(
      "acp:antigravity",
      new Promise((_resolve, reject) => { rejectPrompt = reject; }),
    );

    try {
      const client = await adapter.getClient("acp:antigravity");
      const session = await client.startSession({ cwd: tempDir, executionMode: "default" });
      const promptPromise = client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Work",
        turnId: "turn-err",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Partial update with [shot.png](/tmp/shot.png)." },
      });
      rejectPrompt(new Error("stream interrupted"));
      await Promise.resolve(promptPromise).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const methods = events
        .filter((event) =>
          event.notification.method === "item/completed"
          || event.notification.method === "turn/failed",
        )
        .map((event) => event.notification.method);
      expect(methods).toEqual(["item/completed", "turn/failed"]);
    } finally {
      await adapter.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
