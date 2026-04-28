import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const mcpElicitationSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function openMcpElicitationReplay() {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
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
  await app.advance({ stepId: "mcp-elicitation-1" });

  const pendingMcp = app.window.getByRole("group", {
    name: "Pending MCP interaction"
  });
  await expect(pendingMcp).toBeVisible();
  await expect(pendingMcp.getByText("MCP approval")).toBeVisible();
  await expect(pendingMcp.getByText(/browser_tabs/)).toBeVisible();
  await expect(app.window.getByRole("group", { name: "Pending input" })).toHaveCount(0);
  await expect(app.window.getByRole("group", { name: "Pending approval" })).toHaveCount(0);

  return app;
}

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
