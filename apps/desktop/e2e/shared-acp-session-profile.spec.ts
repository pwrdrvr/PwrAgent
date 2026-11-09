import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { AcpAvailableCommandsStore } from "@pwragent/sqlite-storage/acp-available-commands-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AcpAgentStore } from "../src/main/storage/acp-agent-store";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const backend = "acp:gemini" as const;
const threadId = "portable-acp-session";
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
        new AcpAvailableCommandsStore(db).upsert({ backendId: backend, repositoryPath, observedAt: Date.now(),
          commands: [{ name: "portable-cached", description: "Portable command", backend, scope: "session", source: "provider" }] });
      } finally { db.close(); }
    },
  });
  try {
    await expect(app.window.getByRole("button", { name: /Portable ACP session/i })).toBeVisible();
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
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const sessions = new AcpSessionStore(db);
      expect(sessions.getSession(backend, threadId)).toMatchObject({ title: "Desktop renamed portable ACP",
        agentSessionId: "provider-portable-id", hasConversationHistory: true, availableCommands: normalizedCommands });
      expect(sessions.listSessions(backend)).toEqual([]);
      expect(sessions.listSessions(backend, { archived: true }).map(row => row.sessionId).sort())
        .toEqual(["portable-acp-session", "portable-archived-acp"]);
      expect(new AcpAvailableCommandsStore(db).get(backend, repositoryPath)?.commands).toEqual(normalizedCommands);
    } finally { db.close(); }
  } finally { await app.close(); }
});
