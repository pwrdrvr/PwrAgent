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

    const summary = app.window.locator(".thread-header__summary");
    await expect(summary.locator("strong", { hasText: "thread/read" })).toBeVisible();
    await expect(
      summary.getByRole("link", { name: "desktop docs" })
    ).toHaveAttribute("href", "https://example.com/docs");

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
    await expect(
      transcript.getByText("![Transcript preview](https://example.com/preview.png)")
    ).toBeVisible();
    await expect(
      transcript.locator('img[alt="Transcript preview"]')
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
