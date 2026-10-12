import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import { launchElectronApp } from "./fixtures/electron-app";

const mcpElicitationSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function openMcpElicitationReplay(gatewayApproval = false, urlLogin = false, fixturePath?: string) {
  const app = await launchElectronApp({
    fixturePath: fixturePath ?? path.resolve(
      mcpElicitationSpecDir,
      "fixtures/mcp-elicitation/replay.fixture.json"
    )
  });

  await app.window
    .getByRole("button", { name: /MCP elicitation replay/i })
    .first()
    .click();

  await expect(
    app.window.getByRole("heading", {
      level: 2,
      name: "MCP elicitation replay"
    })
  ).toBeVisible();

  await app.window
    .getByLabel("Reply")
    .fill("Use the browser tabs MCP tool.");
  await app.window.getByRole("button", { name: "Send" }).click();

  await app.advance({ stepId: "status-active-1" });
  await app.advance({ stepId: "turn-started-1" });
  await app.advance({ stepId: "mcp-startup-1" });
  await app.advance({ stepId: "mcp-tool-started-1" });
  await app.advance({
    stepId: "mcp-elicitation-1",
    ...(gatewayApproval ? { override: { request: { params: {
      _meta: { pwragent_approval_kind: "mcp_tool_call", persist: ["session"] },
    } } } } : {}),
    ...(urlLogin ? { override: { request: { params: {
      mode: "url", serverName: "codex_apps", _meta: null,
      message: "Reconnect GitHub to restore access to repositories.",
      url: "https://chatgpt.com/connector", elicitationId: "mcp-login-1",
    } } } } : {}),
  });

  const pendingMcp = app.window.getByRole("group", {
    name: "Pending MCP interaction"
  });
  await expect(pendingMcp).toBeVisible();
  await expect(pendingMcp.getByText(urlLogin ? "MCP login" : "MCP approval")).toBeVisible();
  await expect(pendingMcp.getByText(urlLogin ? /restore access to repositories/ : /browser_tabs/)).toBeVisible();
  await expect(app.window.getByRole("group", { name: "Pending input" })).toHaveCount(0);
  await expect(app.window.getByRole("group", { name: "Pending approval" })).toHaveCount(0);

  return app;
}

test("recovers concurrent MCP login prompts and answers from To-dos", async ({ browserName: _browserName }, testInfo) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-mcp-concurrent-"));
  let closeApp: (() => Promise<void>) | undefined;
  try {
    const fixture = JSON.parse(await readFile(path.resolve(
      mcpElicitationSpecDir, "fixtures/mcp-elicitation/replay.fixture.json",
    ), "utf8")) as ReplayFixture;
    const requestIndex = fixture.steps.findIndex((step) => step.id === "mcp-elicitation-1");
    fixture.steps.splice(requestIndex + 1, 0, {
      id: "mcp-login-2", kind: "request", request: {
        method: "mcpServer/elicitation/request", params: {
          threadId: "thread-mcp-elicitation", turnId: "turn-mcp-2", requestId: "mcp-login-request-2",
          serverName: "codex_apps", mode: "url", message: "Reconnect GitHub to inspect pull requests.",
          url: "https://chatgpt.com/connector", elicitationId: "mcp-login-2",
        },
      },
    });
    const fixturePath = path.join(fixtureRoot, "replay.fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture));
    const app = await openMcpElicitationReplay(false, true, fixturePath);
    closeApp = app.close;
    const pendingMcp = app.window.getByRole("group", { name: "Pending MCP interaction" });
    await app.advance({ stepId: "mcp-login-2" });
    await expect(pendingMcp).toContainText("inspect pull requests");
    await pendingMcp.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(pendingMcp).toContainText("restore access to repositories");

    await app.window.getByRole("tab", { name: /^To-dos/ }).click();
    const row = app.window.locator('.thread-todos-panel__row[data-wait-kind="mcp-input"]');
    await expect(row).toContainText("restore access to repositories");
    await expect(row.getByRole("link", { name: "Open", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
    await app.window.screenshot({ path: testInfo.outputPath("mcp-login-recovered.png") });
    await row.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(pendingMcp).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect.poll(async () => await app.getPendingRequest()).toBeUndefined();
  } finally {
    try {
      await closeApp?.();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("accepts MCP elicitations and resumes MCP progress", async () => {
  const app = await openMcpElicitationReplay();

  try {
    const pendingMcp = app.window.getByRole("group", {
      name: "Pending MCP interaction"
    });

    await pendingMcp.getByRole("button", { name: "Allow" }).click();
    await expect(pendingMcp).toHaveCount(0);
    await expect(app.window.getByRole("status")).toContainText("Thinking");
    await expect
      .poll(async () => await app.getPendingRequest())
      .toBeUndefined();

    await app.advance({ stepId: "mcp-progress-1" });
    await expect(app.window.getByText("MCP Listing browser tabs").first()).toBeVisible();

    await app.advance({ stepId: "mcp-tool-completed-1" });
    await expect(
      app.window.getByText(/Used MCP playwright\/browser_tabs/)
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("accepts a gateway conversation approval through the thread UI", async () => {
  const app = await openMcpElicitationReplay(true);

  try {
    const pendingMcp = app.window.getByRole("group", {
      name: "Pending MCP interaction",
    });
    await expect(pendingMcp.getByRole("button", { name: "Always allow" })).toHaveCount(0);
    await expect(pendingMcp.getByRole("button", { name: "Allow once" })).toBeVisible();
    await pendingMcp.getByRole("button", { name: "Allow this conversation" }).click();
    await expect(pendingMcp).toHaveCount(0);
    await expect(app.window.getByRole("status")).toContainText("Thinking");
    await expect.poll(async () => await app.getPendingRequest()).toBeUndefined();

    await app.advance({ stepId: "mcp-progress-1" });
    await app.advance({ stepId: "mcp-tool-completed-1" });
    await expect(app.window.getByText(/Used MCP playwright\/browser_tabs/)).toBeVisible();
  } finally {
    await app.close();
  }
});

test("preserves one-time gateway approval through the thread UI", async () => {
  const app = await openMcpElicitationReplay(true);

  try {
    const pendingMcp = app.window.getByRole("group", { name: "Pending MCP interaction" });
    await expect(pendingMcp.getByRole("button", { name: "Allow this conversation" })).toBeVisible();
    await pendingMcp.getByRole("button", { name: "Allow once" }).click();
    await expect(pendingMcp).toHaveCount(0);
    await expect.poll(async () => await app.getPendingRequest()).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("declines MCP elicitations without showing approval or questionnaire UI", async () => {
  const app = await openMcpElicitationReplay();

  try {
    const pendingMcp = app.window.getByRole("group", {
      name: "Pending MCP interaction"
    });

    await pendingMcp.getByRole("button", { name: "Decline" }).click();
    await expect(pendingMcp).toHaveCount(0);
    await expect(app.window.getByRole("group", { name: "Pending input" })).toHaveCount(0);
    await expect(app.window.getByRole("group", { name: "Pending approval" })).toHaveCount(0);
    await expect
      .poll(async () => await app.getPendingRequest())
      .toBeUndefined();
  } finally {
    await app.close();
  }
});
