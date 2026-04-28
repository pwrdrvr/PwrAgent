import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("preserves live assistant commentary messages, tool usage, and final answer", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-agent-messages/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Telegram brainstorm replay/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Telegram brainstorm replay"
      })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript).toContainText("Ready to brainstorm Telegram support.");
    const hydratedWorkToggle = transcript.getByRole("button", {
      name: /Worked for 1m 10s/
    });
    await expect(hydratedWorkToggle).toBeVisible();
    await expect(hydratedWorkToggle).toHaveAttribute("aria-expanded", "false");
    await expect(transcript.getByText("I checked the existing Telegram notes")).toBeHidden();
    await expect(transcript).toContainText("Hydrated final answer stays visible.");
    await hydratedWorkToggle.click();
    await expect(hydratedWorkToggle).toHaveAttribute("aria-expanded", "true");
    await expect(transcript.getByText("I checked the existing Telegram notes")).toBeVisible();
    await expect(transcript.getByText("Edited 1 file")).toBeVisible();
    await hydratedWorkToggle.click();
    await expect(hydratedWorkToggle).toHaveAttribute("aria-expanded", "false");

    await app.window
      .getByLabel("Reply")
      .fill("What would it take to add Telegram support?");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "tool-search-started-1" });
    await expect(transcript).toContainText("Searching Web");

    await app.advance({ stepId: "assistant-message-1a" });
    await app.advance({ stepId: "assistant-message-1b" });
    await expect(transcript).toContainText("Using ce:brainstorm for this.");
    await expect(transcript).toContainText("What would it take to add Telegram support?");

    await app.advance({ stepId: "tool-search-completed-1" });
    await app.advance({ stepId: "tool-command-started-1" });
    await app.advance({ stepId: "assistant-message-2" });
    await expect(transcript).toContainText("Using ce:brainstorm for this.");
    await expect(transcript).toContainText("The broad search was too noisy");
    let transcriptText = await transcript.innerText();
    expect(transcriptText.indexOf("What would it take to add Telegram support?")).toBeGreaterThan(
      transcriptText.indexOf("Ready to brainstorm Telegram support.")
    );
    expect(transcriptText.indexOf("Using ce:brainstorm for this.")).toBeGreaterThan(
      transcriptText.indexOf("What would it take to add Telegram support?")
    );
    expect(transcriptText.indexOf("The broad search was too noisy")).toBeGreaterThan(
      transcriptText.indexOf("Using ce:brainstorm for this.")
    );

    await app.advance({ stepId: "tool-command-completed-1" });
    await app.advance({ stepId: "assistant-message-3" });
    await expect(transcript).toContainText("Using ce:brainstorm for this.");
    await expect(transcript).toContainText("The broad search was too noisy");
    await expect(transcript).toContainText("The existing product direction is thread-first");

    await app.advance({ stepId: "assistant-message-4" });
    await app.advance({ stepId: "assistant-message-5" });
    await app.advance({ stepId: "assistant-message-6" });
    await expect(transcript.getByRole("button", { name: /previous messages?/ })).toHaveCount(0);
    await expect(transcript.getByText("Using ce:brainstorm for this.")).toBeVisible();
    await expect(transcript.getByText("The broad search was too noisy")).toBeVisible();
    await expect(transcript.getByText("The existing product direction is thread-first")).toBeVisible();
    await expect(transcript.getByText("From the repo scan, Telegram should probably")).toBeVisible();
    await expect(transcript.getByText("The v1 shape should probably focus")).toBeVisible();
    await expect(transcript.getByText("I’m ready to turn that into requirements")).toBeVisible();

    const toolSummary = transcript.getByRole("button", { name: /Used 2 tools/i });
    await expect(toolSummary).toBeVisible();
    await toolSummary.click();
    await expect(transcript).toContainText("Searched Web (8.4s)");
    await expect(transcript).toContainText(
      'rg -n "Telegram|telegram|webhook" docs apps packages (1.1s)'
    );

    await app.advance({ stepId: "turn-completed-1" });

    await expect(app.window.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(app.window.getByText("Thinking")).toHaveCount(0);
    const workedForToggle = transcript.getByRole("button", {
      name: /Worked for 8m/
    });
    await expect(workedForToggle).toBeVisible();
    await expect(workedForToggle).toHaveAttribute("aria-expanded", "false");
    await expect(transcript.getByText("Using ce:brainstorm for this.")).toBeHidden();
    await expect(transcript.getByText("The broad search was too noisy")).toBeHidden();
    await expect(transcript.getByText("The existing product direction is thread-first")).toBeHidden();
    await expect(transcript.getByRole("button", { name: /Used 2 tools/i })).toBeHidden();
    await expect(transcript).toContainText(
      "From the repo scan: Telegram support is probably not another model provider."
    );
    await expect(transcript).toContainText(
      "Remote control: Telegram lets you start, steer, approve, and monitor agent threads from mobile."
    );
    transcriptText = await transcript.innerText();
    expect(transcriptText.indexOf("What would it take to add Telegram support?")).toBeGreaterThan(
      transcriptText.indexOf("Ready to brainstorm Telegram support.")
    );

    await workedForToggle.click();
    await expect(workedForToggle).toHaveAttribute("aria-expanded", "true");
    await expect(transcript.getByText("Using ce:brainstorm for this.")).toBeVisible();
    await expect(transcript.getByText("The broad search was too noisy")).toBeVisible();
    await expect(transcript.getByText("The existing product direction is thread-first")).toBeVisible();
    await expect(transcript.getByText("From the repo scan, Telegram should probably")).toBeVisible();
    await expect(transcript.getByText("The v1 shape should probably focus")).toBeVisible();
    await expect(transcript.getByText("I’m ready to turn that into requirements")).toBeVisible();
    await expect(transcript.getByRole("button", { name: /Used 2 tools/i })).toBeVisible();
  } finally {
    await app.close();
  }
});
