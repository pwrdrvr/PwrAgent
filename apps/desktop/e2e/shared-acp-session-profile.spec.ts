import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { AcpAvailableCommandsStore } from "@pwragent/sqlite-storage/acp-available-commands-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { AcpAgentStore } from "../src/main/storage/acp-agent-store";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve(specDir, "../../../packages/pwragent/src", file)).href);
test.beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(specDir, "../../../packages/pwragent/scripts/build.mjs")], {
    cwd: path.resolve(specDir, "../../.."), stdio: "pipe",
  });
});
const backend = "acp:gemini" as const;
const threadId = "portable-acp-session";
const baselineId = "portable-baseline-acp";
const restoredId = "00000000-0000-4000-8000-000000000004";
const providerCommands = [{ name: "portable-live", description: "Provider command", aliases: ["live"], input: { hint: "<fixture>" } }];
const normalizedCommands = [{ name: "portable-live", description: "Provider command", aliases: ["live"],
  argumentHint: "<fixture>", backend, scope: "session", source: "provider" }];

function providerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (message.method === "session/load") {
    const sessionId = message.params.sessionId;
    for (const update of [
      { sessionUpdate: "available_commands_update", availableCommands: ${JSON.stringify(providerCommands)} },
      { kind: "pwragent_user_prompt", prompt: "Invented provider question", turnId: "portable-provider-turn" },
      { kind: "agent_message_chunk", content: "Invented provider replay." },
      { kind: "turn_finished", turnId: "portable-provider-turn" }
    ]) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});`;
}

test("desktop reads portable ACP metadata and commands and hands provider and owner mutations back to Node", async () => {
  let repositoryPath = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/acp-runtime-modes/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      // The owner keys command caches with forward slashes on every host.
      repositoryPath = path.join(homeRoot, "portable-acp-repo").replaceAll("\\", "/");
      await mkdir(repositoryPath, { recursive: true });
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        new AcpAgentStore(db).upsertInstalledAgent({ backendId: backend, registryId: "gemini", name: "Gemini CLI",
          distributionKind: "local", distributionSource: "Invented ACP fixture", installStatus: "installed",
          authStatus: "not-required", verificationStatus: "not-applicable", allowlistRuleId: "e2e-portable-acp",
          installedAt: 1_779_400_000_000, updatedAt: 1_779_400_000_000,
          launchDescriptor: { backendId: backend, registryId: "gemini", distributionKind: "local",
            command: process.execPath, args: ["-e", providerScript()], env: {} },
        });
        const sessions = new AcpSessionStore(db);
        sessions.upsertSession({ backendId: backend, sessionId: threadId, agentSessionId: "provider-portable-id",
          title: "Portable ACP session", titleSource: "explicit", cwd: repositoryPath, createdAt: 1_779_400_000_000,
          updatedAt: 1_779_400_000_001, status: "idle", executionMode: "default",
          transcriptUpdates: [{ receivedAt: 1, update: { kind: "user_message_chunk", content: "PRIVATE portable legacy history" } }],
        } as Parameters<AcpSessionStore["upsertSession"]>[0]);
        sessions.upsertSession({ backendId: backend, sessionId: "portable-archived-acp", title: "Portable archived ACP",
          cwd: repositoryPath, createdAt: 1_779_400_000_000, updatedAt: 1_779_400_000_002,
          archivedAt: 1_779_400_000_003, status: "idle", executionMode: "default" });
        sessions.upsertSession({ backendId: backend, sessionId: baselineId, title: "Portable baseline ACP", titleSource: "explicit",
          cwd: repositoryPath, createdAt: 0, updatedAt: 2, status: "idle", executionMode: "default" });
        const overlay = new SqliteOverlayStore(db);
        overlay.initializeNavigationUnreadBaseline(overlay.readNavigationQueryIndex({ backend, threads: [{
          id: baselineId, source: backend, title: "Portable baseline ACP", titleSource: "explicit",
          createdAt: 0, updatedAt: 2, linkedDirectories: [],
        }] }).threads);
        new AcpAvailableCommandsStore(db).upsert({ backendId: backend, repositoryPath, observedAt: Date.now(),
          commands: [{ name: "portable-cached", description: "Portable command", backend, scope: "session", source: "provider" }] });
      } finally { db.close(); }
    },
  });
  try {
    await expect(app.window.getByRole("button", { name: /Portable ACP session/i })).toBeVisible();
    const desktopBaseline = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.getNavigationSelectedDetail!({ protocol: 2, ref })).thread;
    }, { backend, threadId: baselineId });
    expect(desktopBaseline?.inbox.inInbox).toBe(false);
    const cached = await app.window.evaluate(async ({ backend, cwd }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.listSkills!({ backend, cwd });
    }, { backend, cwd: repositoryPath });
    expect(cached.data[0]?.commands).toEqual([{ name: "portable-cached", description: "Portable command",
      backend, scope: "session", source: "provider" }]);
    await app.window.getByRole("button", { name: /Portable ACP session/i }).click();
    await expect(app.window.getByText("Invented provider replay.")).toBeVisible();
    await expect(app.window.getByText("PRIVATE portable legacy history")).toHaveCount(0);
    const result = await app.window.evaluate(async ({ backend, threadId }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const commands = await api.listSkills!({ backend, threadId });
      const renamed = await api.renameThread!({ backend, threadId, name: "Desktop renamed portable ACP" });
      const archived = await api.archiveThread!({ backend, threadId });
      return { commands, renamed, archived };
    }, { backend, threadId });
    expect(result.commands.data[0]?.commands).toEqual(normalizedCommands);
    // The write-through is asynchronous; observe the persisted fact through a
    // separate read-only WAL connection before shutdown or a Node store can act.
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      await expect.poll(() => JSON.parse(raw.prepare(`SELECT payload FROM acp_available_commands
        WHERE backend_id = ? AND repository_path = ?`).pluck().get(backend, repositoryPath) as string))
        .toEqual(normalizedCommands);
      const payload = raw.prepare("SELECT payload FROM acp_sessions WHERE backend_id = ? AND session_id = ?")
        .pluck().get(backend, threadId) as string;
      expect(JSON.parse(payload)).toMatchObject({ title: "Desktop renamed portable ACP", titleSource: "explicit",
        hasConversationHistory: true, availableCommands: normalizedCommands });
      expect(JSON.parse(payload).archivedAt).toBeGreaterThan(0);
      expect(payload).not.toContain("PRIVATE");
      expect(payload).not.toContain("Invented provider replay");
      expect(JSON.parse(payload)).not.toHaveProperty("transcriptUpdates");
    } finally { raw.close(); }
    await app.closeApplication();
    const desktopDb = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const overlay = new SqliteOverlayStore(desktopDb);
      expect((await overlay.getThreadMetadata({ backend, threadId: baselineId }))?.seenUpdatedAt).toBeUndefined();
      await overlay.observeArchivedThreads([{ backend, threadId: baselineId }], 0);
      new AcpSessionStore(desktopDb).upsertSession({ backendId: backend, sessionId: restoredId,
        title: "Restored active ACP", titleSource: "explicit", createdAt: 1, updatedAt: 20, status: "active", executionMode: "default" });
      const claudeThread = { id: restoredId, source: "claude" as const, title: "Restored active Claude", titleSource: "explicit" as const,
        createdAt: 1, updatedAt: 20, threadStatus: "active" as const, linkedDirectories: [], executionMode: "default" as const };
      new ProviderThreadSnapshotStore(desktopDb).replace({ backend: "claude", observedAt: 1, threads: [claudeThread] });
      const claudeRoot = path.join(path.dirname(stateDbPathForHomeRoot(app.homeRoot)), "claude");
      await mkdir(claudeRoot, { recursive: true, mode: 0o700 });
      await writeFile(path.join(claudeRoot, `${restoredId}.json`), JSON.stringify({ cwd: app.homeRoot, thread: claudeThread }), { mode: 0o600 });
      for (const source of [backend, "claude"] as const) {
        await overlay.updateThreadMetadata({ backend: source, threadId: restoredId }, { archivedAt: 2, restoredAt: 3, seenUpdatedAt: 20 });
      }
    } finally { desktopDb.close(); }
    const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
    const stateDirectory = path.dirname(stateDbPathForHomeRoot(app.homeRoot));
    const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(path.join(stateDirectory, "headless"), { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const owner = new HeadlessBackend({ workspace: app.homeRoot, store, onFailure(error: unknown) { throw error; },
        projects: { list: () => [] } }, () => {});
      const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref: { backend, threadId } });
      expect(detail.identity).toBe("archived");
      expect(detail.thread).toMatchObject({ id: threadId, source: backend, title: "Desktop renamed portable ACP", titleSource: "explicit" });
      const baseline = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref: { backend, threadId: baselineId } });
      expect(baseline.thread.inbox.inInbox).toBe(desktopBaseline!.inbox.inInbox);
      expect(baseline.identity).toBe("archived");
      expect((await owner.handle("lookupArchivedThreads", { backend, threadIds: [threadId] })).threads)
        .toMatchObject([{ id: threadId, source: backend, title: "Desktop renamed portable ACP" }]);
      for (const source of [backend, "claude"] as const) {
        const active = source === backend;
        const restored = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref: { backend: source, threadId: restoredId } });
        expect(restored.identity).toBe("present");
        expect(restored.thread).toMatchObject({ source, threadStatus: active ? "active" : "idle", inbox: { inInbox: false } });
        expect(restored.thread.archivedAt).toBeUndefined();
        const attention = await owner.handle("getNavigationQueryPage", { protocol: 2, backend: source, query: { kind: "lens", lens: "attention" } });
        expect(attention.counts).toMatchObject({ total: 1, active: active ? 1 : 0, unread: 0 });
        expect(attention.entries.map((entry: { row: { source: string; id: string } }) => [entry.row.source, entry.row.id]))
          .toEqual(active ? [[source, restoredId]] : []);
        expect((await owner.handle("getNavigationQueryPage", { protocol: 2, backend: source, query: { kind: "model-inventory" } })).counts.total).toBe(1);
      }
      await expect(owner.handle("startTurn", { backend, threadId })).rejects.toThrow("executes Codex only");
    } finally { profile.close(); }
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const sessions = new AcpSessionStore(db);
      expect(sessions.getSession(backend, threadId)).toMatchObject({ title: "Desktop renamed portable ACP",
        agentSessionId: "provider-portable-id", hasConversationHistory: true, availableCommands: normalizedCommands });
      expect(sessions.listSessions(backend).map(row => row.sessionId).sort()).toEqual([baselineId, restoredId].sort());
      expect(sessions.listSessions(backend, { archived: true }).map(row => row.sessionId).sort())
        .toEqual(["portable-acp-session", "portable-archived-acp"]);
      expect(new AcpAvailableCommandsStore(db).get(backend, repositoryPath)?.commands).toEqual(normalizedCommands);
    } finally { db.close(); }
  } finally { await app.close(); }
});

test("desktop and Outpost retire actual ACP active/archive members despite retained pins and inventories", async () => {
  const ids = ["retired-active", "retired-archived"];
  const other = "acp:uninstalled" as const;
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"), secretStorage: "memory",
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const sessions = new AcpSessionStore(db);
        const overlay = new SqliteOverlayStore(db);
        const repo = path.join(homeRoot, "enriched-repo");
        const cwd = path.join(homeRoot, ".worktrees", "enriched-member");
        await mkdir(repo, { recursive: true });
        await mkdir(path.join(cwd, ".codex", "environments"), { recursive: true });
        await writeFile(path.join(cwd, ".codex", "environments", "environment.toml"), 'version = 1\nname = "Invented ACP environment"\n');
        for (const [index, id] of ids.entries()) {
          sessions.upsertSession({ backendId: backend, sessionId: id, title: `Invented ACP ${index}`, titleSource: "derived",
            cwd, createdAt: 1, updatedAt: 2, executionMode: "auto", status: "idle", ...(index ? { archivedAt: 3 } : {}) });
          await overlay.updateThreadMetadata({ backend, threadId: id }, { pinnedRank: `${1024 + index}`, seenAt: 10_000, seenUpdatedAt: 2 });
          await overlay.setAcpWorktreeDirectory({ backend, threadId: id, cwd,
            directory: { id: repo, path: repo, worktreePath: cwd, kind: "worktree", label: "enriched-repo" } });
        }
        sessions.upsertSession({ backendId: other, sessionId: ids[0]!, title: "Uninstalled ACP member", titleSource: "explicit",
          cwd: homeRoot, createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle" });
      } finally { db.close(); }
    },
  });
  try {
    await expect(app.window.getByRole("button", { name: /Invented ACP 0/i }).first()).toBeVisible();
    await expect(app.window.getByRole("button", { name: /Uninstalled ACP member/i }).first()).toBeVisible();
    const before = await app.window.evaluate(async ({ backend, ids }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const active = await api.getNavigationSelectedDetail!({ protocol: 2, ref: { backend, threadId: ids[0]! } });
      const archived = await api.listThreads!({ backend, archived: true });
      return [active.thread!, archived.threads.find(thread => thread.id === ids[1])!];
    }, { backend, ids });
    expect(before[0]).toMatchObject({ title: "Invented ACP 0", executionMode: "auto", pinnedRank: "1024" });
    expect(before[1]).toMatchObject({ title: "Invented ACP 1", archivedAt: 3 });
    const cached = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.listThreads!();
    });
    expect(cached.threads.find(thread => thread.id === ids[0] && thread.source === backend)).toMatchObject({
      linkedDirectories: [{ path: path.join(app.homeRoot, "enriched-repo"), worktreePath: path.join(app.homeRoot, ".worktrees", "enriched-member") }],
      codexEnvironmentOptions: [{ name: "Invented ACP environment" }],
    });
    await app.closeApplication();
    const stateDirectory = path.dirname(stateDbPathForHomeRoot(app.homeRoot));
    const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
    const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(path.join(stateDirectory, "headless"), { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const runtime = { workspace: app.homeRoot, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; } };
      let owner = new HeadlessBackend(runtime, () => {});
      for (const [index, id] of ids.entries()) expect((await owner.handle("getNavigationSelectedDetail", {
        protocol: 2, ref: { backend, threadId: id },
      })).identity).toBe(index ? "archived" : "present");
      const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
      try {
        new ProviderThreadSnapshotStore(db).replace({ backend, observedAt: Date.now() + 100_000,
          threads: before });
        for (const id of ids) new AcpSessionStore(db).deleteSession(backend, id);
      } finally { db.close(); }
      for (let reopen = 0; reopen < 2; reopen++) {
        for (const id of ids) {
          const ref = { backend, threadId: id };
          expect((await owner.handle("resolveThread", ref)).thread).toBeUndefined();
          expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe("unresolved");
          expect((await owner.handle("getNavigationQueryPage", { protocol: 2, consumer: "remote-window", backend,
            query: { kind: "exact", identities: [ref] } })).entries).toEqual([]);
        }
        expect((await owner.handle("lookupArchivedThreads", { backend, threadIds: ids, includeParent: true })).parentLinks).toEqual([]);
        expect((await owner.handle("resolveThread", { backend: other, threadId: ids[0] })).thread.title).toBe("Uninstalled ACP member");
        await expect(owner.handle("readThread", { backend: other, threadId: ids[0] })).rejects.toThrow("executes Codex only");
        owner = new HeadlessBackend(runtime, () => {});
      }
    } finally { profile.close(); }
  } finally { await app.close(); }
});
