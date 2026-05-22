import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { AcpBackendId } from "@pwragent/shared";
import { AcpAgentStore } from "../src/main/acp/acp-agent-store";
import { AcpSessionStore } from "../src/main/acp/acp-session-store";
import { StateDb } from "../src/main/state/state-db";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

const geminiBackendId = "acp:gemini" as AcpBackendId;

function acpMockScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let currentModeId = "yolo";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === "session/load") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        modes: {
          currentModeId,
          availableModes: [
            { id: "default", name: "Default" },
            { id: "autoEdit", name: "Auto Edit" },
            { id: "yolo", name: "YOLO" }
          ]
        }
      }
    });
    return;
  }
  if (msg.method === "session/set_mode") {
    currentModeId = msg.params.modeId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: { kind: "agent_message_chunk", content: "[MODE_UPDATE] " + msg.params.modeId }
      }
    });
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;
}

async function seedAcpGemini(homeRoot: string): Promise<void> {
  const dbPath = path.join(homeRoot, ".pwragent/profiles/default/state/state.db");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = StateDb.open(dbPath, { profileName: "default" });
  try {
    new AcpAgentStore(db).upsertInstalledAgent({
      backendId: geminiBackendId,
      registryId: "gemini",
      name: "Gemini CLI",
      distributionKind: "local",
      distributionSource: "node -e <mock-acp>",
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "e2e-gemini",
      installedAt: 1779400000000,
      updatedAt: 1779400000000,
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        discoveredAt: 1779400000000,
        checkedAt: 1779400000000,
        source: "session-load",
        modes: {
          currentModeId: "yolo",
          availableModes: [
            { id: "default", label: "Default" },
            { id: "autoEdit", label: "Auto Edit" },
            { id: "yolo", label: "YOLO" },
          ],
        },
      },
      launchDescriptor: {
        backendId: geminiBackendId,
        registryId: "gemini",
        distributionKind: "local",
        command: process.execPath,
        args: ["-e", acpMockScript()],
        env: {},
      },
    });
    new AcpSessionStore(db).upsertSession({
      backendId: geminiBackendId,
      sessionId: "acp-yolo-thread",
      title: "ACP Yolo Thread",
      cwd: "/tmp/acp-yolo-thread",
      createdAt: 1779400000000,
      updatedAt: 1779400000000,
      executionMode: "default",
      acpRuntime: {
        currentModeId: "yolo",
        updatedAt: 1779400000000,
      },
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 1779400000000,
          update: {
            kind: "agent_message_chunk",
            content: "Ready.",
          },
        },
      ],
    });
  } finally {
    db.close();
  }
}

test("renders ACP-native runtime modes and updates them without transcript noise", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/acp-runtime-modes/replay.fixture.json",
    ),
    preLaunchHook: seedAcpGemini,
  });

  try {
    await app.window.getByRole("button", { name: /ACP Yolo Thread/i }).click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "ACP Yolo Thread" }),
    ).toBeVisible();
    await expect(app.window.locator(".thread-header .chip--mode")).toHaveText(
      "Yolo",
    );

    const acpMode = app.window.getByLabel("ACP mode");
    await expect(acpMode).toBeEnabled();
    await expect(acpMode).toHaveAttribute("data-value", "yolo");

    await acpMode.click();
    await app.window.getByRole("option", { name: "Default" }).click();

    await expect(acpMode).toHaveAttribute("data-value", "default");
    await expect(app.window.getByText("[MODE_UPDATE]")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
