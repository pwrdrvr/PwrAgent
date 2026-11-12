import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon } from "./helpers/outpost-daemon";

describe.skipIf(process.platform === "win32")("desktop client against the standalone outpost", () => {
  it.each(["direct", "symlink"] as const)("uses the current navigation, composer, transcript and project contracts (%s workspace)", async (workspaceKind) => {
    const outpost = await startOutpostDaemon({ workspaceKind });
    const { client, workspace, viewerId } = outpost;
    try {
      const created = await client.startThread({ backend: "codex", cwd: workspace, executionMode: "auto" });
      const providers = await client.listBackends({});
      expect(providers.backends.map(backend => backend.kind)).toEqual(["codex"]);
      expect(providers.backends[0].launchpadOptions?.models?.length).toBeGreaterThan(0);
      const projects = await client.getProjectPage({});
      const directory = projects.directories.find(directory => directory.path === workspace)!;
      expect(directory).toBeDefined();
      const directoryKey = directory.key;
      const ref = { backend: "codex" as const, threadId: created.threadId };
      // Ordinary threads have not admitted the messaging PDF tool catalog.
      expect(await client.supportsMessagingPdfTools(ref)).toBe(false);
      const model = providers.backends[0].launchpadOptions!.models!.at(-1)!.id;
      await client.setThreadModelSettings({ ...ref, model });
      expect((await client.getNavigationSelectedDetail({ protocol: 2, ref })).thread?.model).toBe(model);
      const page = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory", directoryKey } });
      expect(page.entries[0].row.ref).toEqual(ref);
      expect(page.selectionDirectory?.path).toBe(workspace);
      expect((await client.getNavigationSelectedDetail({ protocol: 2, ref })).thread?.executionMode).toBe("auto");
      expect((await client.getNavigationQueueProjection({ protocol: 2, ref })).entries).toEqual([]);
      expect((await client.resolveThreadAdmissionState(ref)).thread?.id).toBe(created.threadId);
      const turn = await client.startTurn({ ...ref, input: [{ type: "text", text: "hello" }], queueEntryId: "stable-submission" });
      expect(turn.turnId).toBeTruthy();
      let read = await client.readThread(ref);
      for (let attempt = 0; !read.replay.lastAssistantMessage && attempt < 100; attempt++) {
        await delay(20);
        read = await client.readThread(ref);
      }
      expect(read.replay.lastAssistantMessage).toBe("Fixture result");
      // Raw queue IDs cannot admit a second turn after the first was consumed.
      // Lost-response replay belongs to the durable submission/receipt contract.
      await expect(client.startTurn({ ...ref, input: [{ type: "text", text: "hello" }], queueEntryId: "stable-submission" })).rejects.toThrow("already admitted");
      await expect(client.startTurn({ ...ref, input: [{ type: "text", text: "different" }], queueEntryId: "stable-submission" })).rejects.toThrow(/different input|already admitted/);
      expect((await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory-index", keys: ["missing"] } })).directories).toEqual([]);
      const config = await client.getNavigationLaunchpadConfig({ protocol: 2, directoryKey });
      expect(config.directoryKey).toBe(directoryKey);
      expect(config.defaults?.workMode).toBeUndefined();
      const materialized = await client.materializeDirectoryLaunchpad({ directoryKey,
        launchpad: { ...config.defaults!, executionMode: "auto", workMode: "local", directoryKey, directoryKind: "directory",
          directoryLabel: "workspace", directoryPath: workspace, prompt: "", createdAt: Date.now(), updatedAt: Date.now() },
        input: [{ type: "text", text: "hello" }],
      });
      expect(materialized.workMode).toBe("local");
      expect(materialized.turnId).toBeTruthy();
      expect(materialized.turnStartFailure).toBeUndefined();
      let launchpadRead = await client.readThread({ backend: "codex", threadId: materialized.threadId });
      for (let attempt = 0; !launchpadRead.replay.lastAssistantMessage && attempt < 100; attempt++) {
        await delay(20);
        launchpadRead = await client.readThread({ backend: "codex", threadId: materialized.threadId });
      }
      expect(launchpadRead.replay.lastAssistantMessage).toBe("Fixture result");
      const project = { path: path.join(workspace, "contract-project") };
      await mkdir(project.path);
      const projectThread = await client.startThread({ backend: "codex", cwd: project.path });
      const messageOrigin = { kind: "messaging" as const,
        causalMessagingSource: { ownerId: "fixture-provider-owner", requestId: "fixture-human-request", instanceId: viewerId },
        messaging: { platform: "slack" as const, surface: { id: "fixture-conversation", kind: "thread" as const }, actor: { platformUserId: "fixture-actor" } } };
      const projectTurn = await client.startTurn({ backend: "codex", threadId: projectThread.threadId,
        messageOrigin, input: [{ type: "text", text: "project-specific chat turn" }] });
      let reply = await client.readTurnAssistantReply({ backend: "codex", threadId: projectThread.threadId, turnId: projectTurn.turnId, text: "Fixture result" });
      for (let attempt = 0; !reply.message && attempt < 100; attempt++) {
        await delay(20);
        reply = await client.readTurnAssistantReply({ backend: "codex", threadId: projectThread.threadId, turnId: projectTurn.turnId, text: "Fixture result" });
      }
      expect(reply.message?.text).toBe("Fixture result");
      const projectDirectory = (await client.getProjectPage({})).directories.find(directory => directory.path === project.path)!;
      const projectPage = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory", directoryKey: projectDirectory.key } });
      expect(projectPage.entries[0].row.ref.threadId).toBe(projectThread.threadId);
      expect(projectPage.entries[0].row.projectKey).toBe(project.path);
    } finally {
      await outpost.close();
    }
  }, 20000);

  // An Outpost is a federation member like a desktop: its execution modes ask
  // for approval, and an operator on any viewer answers.
  it("asks a viewer to approve an Outpost escalation, and the turn continues once approved", async () => {
    const outpost = await startOutpostDaemon({ capabilities: [...OUTPOST_VIEWER_CAPABILITIES, "pending_request_control"] });
    const { client, workspace } = outpost;
    try {
      const { threadId } = await client.startThread({ backend: "codex", cwd: workspace, executionMode: "auto" });
      const ref = { backend: "codex" as const, threadId };
      const turn = await client.startTurn({ ...ref, input: [{ type: "text", text: "approval" }] });
      let read = await client.readThread(ref);
      for (let attempt = 0; !read.pendingRequest && attempt < 100; attempt++) {
        await delay(20);
        read = await client.readThread(ref);
      }
      // On the thread, as the transcript's approval card reads it.
      expect(read.pendingRequest).toMatchObject({ method: "item/commandExecution/requestApproval",
        params: { threadId, turnId: turn.turnId } });
      // In the viewer's Attention lens.
      const attention = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "lens", lens: "attention" } });
      expect(attention.entries.map(entry => entry.row.ref.threadId)).toContain(threadId);
      expect((await client.resolveThreadAdmissionState(ref)).pendingRequest?.method).toBe("item/commandExecution/requestApproval");
      await client.submitServerRequest({ ...ref, requestId: read.pendingRequest!.params.requestId, response: { decision: "accept" } });
      for (let attempt = 0; (read.pendingRequest || !read.replay.lastAssistantMessage) && attempt < 100; attempt++) {
        await delay(20);
        read = await client.readThread(ref);
      }
      expect(read.pendingRequest).toBeUndefined();
      expect(read.replay.lastAssistantMessage).toBe("Fixture result");
      // Codex received the operator's decision.
      expect(readFileSync(path.join(outpost.env.PWRAGENT_TEST_DATA!, "approval-answers.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)))
        .toEqual([{ decision: "accept" }]);
    } finally {
      await outpost.close();
    }
  }, 20000);
});
