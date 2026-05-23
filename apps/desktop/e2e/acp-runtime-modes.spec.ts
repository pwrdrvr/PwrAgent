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
let currentModeId = "default";
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

function acpConfigOptionMockScript(): string {
  return `
	const readline = require("node:readline");
	const rl = readline.createInterface({ input: process.stdin });
	let currentApprovalMode = "default";
	function modeConfig(currentValue) {
	  return [{
	    id: "approval-mode",
	    label: "Approval mode",
	    type: "select",
	    category: "mode",
	    currentValue,
	    values: [
	      { value: "default", label: "Default" },
	      { value: "auto_edit", label: "Auto Edit" },
	      { value: "yolo", label: "YOLO" }
	    ]
	  }];
	}
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
	      result: { configOptions: modeConfig(currentApprovalMode) }
	    });
	    return;
	  }
	  if (msg.method === "session/set_config_option") {
	    currentApprovalMode = msg.params.value;
	    send({
	      jsonrpc: "2.0",
	      method: "session/update",
	      params: {
	        sessionId: msg.params.sessionId,
	        update: { kind: "agent_message_chunk", content: "[MODE_UPDATE] " + msg.params.value }
	      }
	    });
	    send({
	      jsonrpc: "2.0",
	      id: msg.id,
	      result: { configOptions: modeConfig("default") }
	    });
	    return;
	  }
	  send({ jsonrpc: "2.0", id: msg.id, result: {} });
	});
	`;
}

function acpLiveToolProgressMockScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function modes() {
  return {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "yolo", name: "YOLO" }
    ]
  };
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { modes: modes() } });
    return;
  }
  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read_file_1",
          kind: "read",
          title: "README.md",
          status: "in_progress",
          locations: [{ path: "/tmp/acp-live-tool-thread/README.md" }]
        }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "read_file_1",
          kind: "read",
          title: "README.md",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Read lines 1-80 of 200 from README.md"
              }
            }
          ]
        }
      }
    });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Done inspecting README.md." }
          }
        }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }, 2500);
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
          currentModeId: "default",
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
        currentModeId: "default",
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

async function seedAcpGeminiLiveToolProgress(homeRoot: string): Promise<void> {
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
          currentModeId: "default",
          availableModes: [
            { id: "default", label: "Default" },
            { id: "yolo", label: "YOLO" },
          ],
        },
      },
      launchDescriptor: {
        backendId: geminiBackendId,
        registryId: "gemini",
        distributionKind: "local",
        command: process.execPath,
        args: ["-e", acpLiveToolProgressMockScript()],
        env: {},
      },
    });
    new AcpSessionStore(db).upsertSession({
      backendId: geminiBackendId,
      sessionId: "acp-live-tool-thread",
      title: "ACP Live Tool Thread",
      cwd: "/tmp/acp-live-tool-thread",
      createdAt: 1779400000000,
      updatedAt: 1779400000000,
      executionMode: "default",
      acpRuntime: {
        currentModeId: "default",
        updatedAt: 1779400000000,
      },
      status: "idle",
    });
  } finally {
    db.close();
  }
}

async function seedAcpGeminiConfigOptionMode(homeRoot: string): Promise<void> {
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
        configOptions: [
          {
            id: "approval-mode",
            label: "Approval mode",
            type: "select",
            category: "mode",
            currentValue: "default",
            values: [
              { value: "default", label: "Default" },
              { value: "auto_edit", label: "Auto Edit" },
              { value: "yolo", label: "YOLO" },
            ],
          },
        ],
      },
      launchDescriptor: {
        backendId: geminiBackendId,
        registryId: "gemini",
        distributionKind: "local",
        command: process.execPath,
        args: ["-e", acpConfigOptionMockScript()],
        env: {},
      },
    });
    new AcpSessionStore(db).upsertSession({
      backendId: geminiBackendId,
      sessionId: "acp-config-mode-thread",
      title: "ACP Config Mode Thread",
      cwd: "/tmp/acp-config-mode-thread",
      createdAt: 1779400000000,
      updatedAt: 1779400000000,
      executionMode: "default",
      acpRuntime: {
        configValues: { "approval-mode": "default" },
        currentModeId: "default",
        updatedAt: 1779400000000,
      },
      status: "idle",
    });
  } finally {
    db.close();
  }
}

async function seedAcpGeminiWithHistory(homeRoot: string): Promise<void> {
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
      sessionId: "acp-handoff-thread",
      title: "ACP Handoff Thread",
      cwd: "/tmp/acp-handoff-thread",
      createdAt: 1779400000000,
      updatedAt: 1779400000000,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 1779400000000,
          update: {
            kind: "pwragent_user_prompt",
            prompt: "What is this project?",
          },
        },
      ],
    });
  } finally {
    db.close();
  }
}

async function seedAcpGeminiReplayNoise(homeRoot: string): Promise<void> {
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
          currentModeId: "default",
          availableModes: [
            { id: "default", label: "Default" },
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
      sessionId: "acp-replay-noise-thread",
      title: "ACP Replay Noise Thread",
      cwd: "/tmp/acp-replay-noise-thread",
      createdAt: 1779400000000,
      updatedAt: 1779400005000,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 1779400000000,
          update: {
            kind: "pwragent_user_prompt",
            prompt: "What is this project?",
            turnId: "pending:acp-replay-noise-thread:1779400000000",
          },
        },
        {
          receivedAt: 1779400000100,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "What is " },
          },
        },
        {
          receivedAt: 1779400000200,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "this project?" },
          },
        },
        {
          receivedAt: 1779400000300,
          update: {
            kind: "agent_message_chunk",
            content: "[MODE_UPDATE] yolo",
          },
        },
        {
          receivedAt: 1779400000400,
          update: {
            kind: "agent_message_chunk",
            content: "It is PwrAgent.",
          },
        },
        {
          receivedAt: 1779400000500,
          update: {
            kind: "turn_finished",
            turnId: "pending:acp-replay-noise-thread:1779400000000",
          },
        },
      ],
    });
  } finally {
    db.close();
  }
}

async function seedAcpGeminiLegacyImagePrompt(homeRoot: string): Promise<void> {
  const dbPath = path.join(homeRoot, ".pwragent/profiles/default/state/state.db");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = StateDb.open(dbPath, { profileName: "default" });
  const imageUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
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
      sessionId: "acp-legacy-image-thread",
      title: "ACP Legacy Image Thread",
      cwd: "/tmp/acp-legacy-image-thread",
      createdAt: 1779400000000,
      updatedAt: 1779400005000,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 1779400000000,
          update: {
            kind: "pwragent_user_prompt",
            prompt: `What's in this image?\n[Image: ${imageUrl}]`,
            turnId: "pending:acp-legacy-image-thread:1779400000000",
          },
        },
        {
          receivedAt: 1779400001000,
          update: {
            kind: "agent_message_chunk",
            content: "This image is a detailed screenshot.",
          },
        },
        {
          receivedAt: 1779400002000,
          update: {
            kind: "turn_finished",
            turnId: "pending:acp-legacy-image-thread:1779400000000",
          },
        },
      ],
    });
  } finally {
    db.close();
  }
}

test("renders ACP-native runtime modes and keeps live mode chrome in sync", async () => {
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
    const modeChip = app.window.locator(".thread-header .chip--mode");
    await expect(modeChip).toHaveText("Default");

    const acpMode = app.window.getByLabel("ACP mode");
    await expect(acpMode).toBeEnabled();
    await expect(acpMode).toHaveAttribute("data-value", "default");

    await acpMode.click();
    await app.window.getByRole("option", { name: "YOLO" }).click();

    await expect(acpMode).toHaveAttribute("data-value", "yolo");
    await expect(modeChip).toHaveText("Yolo");
    await app.window.waitForTimeout(300);
    await expect(acpMode).toHaveAttribute("data-value", "yolo");
    await expect(modeChip).toHaveText("Yolo");
    await expect(app.window.getByText("[MODE_UPDATE]")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("keeps ACP config-option mode controls in sync when the agent echoes stale config", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/acp-runtime-modes/replay.fixture.json",
    ),
    preLaunchHook: seedAcpGeminiConfigOptionMode,
  });

  try {
    await app.window.getByRole("button", { name: /ACP Config Mode Thread/i }).click();

    const modeChip = app.window.locator(".thread-header .chip--mode");
    const acpMode = app.window.getByLabel("ACP mode");
    await expect(modeChip).toHaveText("Default");
    await expect(acpMode).toHaveAttribute("data-value", "default");

    await acpMode.click();
    await app.window.getByRole("option", { name: "YOLO" }).click();

    await expect(acpMode).toHaveAttribute("data-value", "yolo");
    await expect(modeChip).toHaveText("Yolo");
    await app.window.waitForTimeout(300);
    await expect(acpMode).toHaveAttribute("data-value", "yolo");
    await expect(modeChip).toHaveText("Yolo");
    await expect(app.window.getByText("[MODE_UPDATE]")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("shows ACP tool progress while a turn is still running", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/acp-runtime-modes/replay.fixture.json",
    ),
    preLaunchHook: seedAcpGeminiLiveToolProgress,
  });

  try {
    await app.window.getByRole("button", { name: /ACP Live Tool Thread/i }).click();

    await app.window.getByLabel("Reply").fill("Inspect the project README.");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByText(/Explored 1 item/i)).toBeVisible();
    await app.window.getByRole("button", { name: /Explored 1 item/i }).click();
    await expect(app.window.getByText(/README\.md/)).toBeVisible();
    await expect(
      app.window.getByText(/Read lines 1-80 of 200 from README\.md/),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("repairs legacy ACP image prompts before assistant replies", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/acp-runtime-modes/replay.fixture.json",
    ),
    preLaunchHook: seedAcpGeminiLegacyImagePrompt,
  });

  try {
    await app.window
      .getByRole("button", { name: /ACP Legacy Image Thread/i })
      .click();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(app.window.getByText("What's in this image?")).toHaveCount(1);
    await expect(app.window.getByAltText("Transcript image")).toBeVisible();
    await expect(app.window.getByText("This image is a detailed screenshot.")).toBeVisible();

    const transcriptText = await transcript.innerText();
    expect(transcriptText).not.toContain("data:image/");
    const userIndex = transcriptText.indexOf("What's in this image?");
    const assistantIndex = transcriptText.indexOf("This image is a detailed screenshot.");
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(userIndex);
  } finally {
    await app.close();
  }
});

test("normalizes ACP replay noise without duplicate prompts or mode marker text", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/acp-runtime-modes/replay.fixture.json",
    ),
    preLaunchHook: seedAcpGeminiReplayNoise,
  });

  try {
    await app.window
      .getByRole("button", { name: /ACP Replay Noise Thread/i })
      .click();

    await expect(app.window.getByText("What is this project?")).toHaveCount(1);
    await expect(app.window.getByText("It is PwrAgent.")).toBeVisible();
    await expect(app.window.getByText("[MODE_UPDATE]")).toHaveCount(0);

    const modeChip = app.window.locator(".thread-header .chip--mode");
    await expect(modeChip).toHaveText("Yolo");
  } finally {
    await app.close();
  }
});

test("disables workspace handoff for ACP threads after conversation history", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/acp-runtime-modes/replay.fixture.json",
    ),
    preLaunchHook: seedAcpGeminiWithHistory,
  });

  try {
    await app.window.getByRole("button", { name: /ACP Handoff Thread/i }).click();

    const workspaceMode = app.window.getByLabel("Workspace mode");
    await expect(workspaceMode).toBeDisabled();
    await expect(workspaceMode).toHaveAttribute("value", "local");
    await workspaceMode.click({ force: true });
    await expect(
      app.window.getByRole("menuitem", { name: "Handoff to New Worktree" }),
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("dialog", { name: /Handoff to/i }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
