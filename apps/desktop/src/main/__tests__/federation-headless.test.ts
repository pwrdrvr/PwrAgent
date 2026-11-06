import { execFile } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { startOutpostDaemon } from "./helpers/outpost-daemon";

describe.skipIf(process.platform === "win32")("desktop client against the standalone outpost", () => {
  it.each(["direct", "symlink"] as const)("uses the current navigation, composer, transcript and project contracts (%s workspace)", async (workspaceKind) => {
    const outpost = await startOutpostDaemon({ workspaceKind });
    const { client, workspace, cli, env, viewerId } = outpost;
    try {
      const providers = await client.listBackends({});
      expect(providers.backends[0].launchpadOptions?.models?.[0].id).toBe("fixture-model");
      const projects = await client.getProjectPage({});
      expect(projects.directories[0].path).toBe(workspace);
      const created = await client.startThread({ backend: "codex", cwd: workspace, executionMode: "auto" });
      const ref = { backend: "codex" as const, threadId: created.threadId };
      expect(await client.supportsMessagingPdfTools(ref)).toBe(true);
      const page = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory", directoryKey: workspace } });
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
      // A lost response can be retried with the viewer's stable submission ID.
      expect((await client.startTurn({ ...ref, input: [{ type: "text", text: "hello" }], queueEntryId: "stable-submission" })).turnId).toBe(turn.turnId);
      await expect(client.startTurn({ ...ref, input: [{ type: "text", text: "different" }], queueEntryId: "stable-submission" })).rejects.toThrow("different input");
      expect((await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory-index", keys: ["missing"] } })).directories).toEqual([]);
      const config = await client.getNavigationLaunchpadConfig({ protocol: 2, directoryKey: workspace });
      expect(config.directoryKey).toBe(workspace);
      expect(config.defaults?.workMode).toBe("local");
      const materialized = await client.materializeDirectoryLaunchpad({ directoryKey: workspace,
        launchpad: { ...config.defaults!, executionMode: "auto", workMode: "local", directoryKey: workspace, directoryKind: "directory",
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
      const projectOutput = await promisify(execFile)(process.execPath, [cli, "project-create", "--name", "contract-project"], { env });
      const project = JSON.parse(projectOutput.stdout) as { path: string };
      expect(project.path).toBe(path.join(workspace, "contract-project"));
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
      const projectPage = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory", directoryKey: project.path } });
      expect(projectPage.entries[0].row.ref.threadId).toBe(projectThread.threadId);
      expect(projectPage.entries[0].row.projectKey).toBe(project.path);
    } finally {
      await outpost.close();
    }
  }, 20000);
});
