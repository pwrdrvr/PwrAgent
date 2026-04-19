import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const threadMarkdownSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("renders markdown content in thread summaries and transcript messages", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      threadMarkdownSpecDir,
      "fixtures/thread-markdown/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Markdown replay thread/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Markdown replay thread"
      })
    ).toBeVisible();

    await expect(app.window.locator(".thread-header__summary")).toHaveCount(0);

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(
      transcript.locator(".skill-chip", { hasText: "$frontend-design" })
    ).toBeVisible();
    await expect(
      transcript.getByRole("link", { name: "ce:work" })
    ).toHaveAttribute(
      "href",
      "file:///Users/huntharo/.codex/skills/ce-work/SKILL.md"
    );
    await expect(
      transcript.locator("strong", { hasText: "markdown" })
    ).toBeVisible();
    await expect(
      transcript.getByRole("link", { name: "external links" })
    ).toHaveAttribute("href", "https://example.com/transcript");
    await expect(transcript.getByText("Preserves file links")).toBeVisible();
    await expect(transcript).toContainText("Keeps");
    await expect(transcript).toContainText("inert");
  } finally {
    await app.close();
  }
});
