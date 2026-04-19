import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const threadMarkdownEdgeCasesSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("renders markdown edge cases without breaking transcript boundaries", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      threadMarkdownEdgeCasesSpecDir,
      "fixtures/thread-markdown-edge-cases/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Markdown edge cases/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Markdown edge cases"
      })
    ).toBeVisible();

    await expect(app.window.locator(".thread-header__summary")).toHaveCount(0);

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript.getByText("Emoji check 😎")).toBeVisible();
    await expect(transcript.getByText("Single newline survives.")).toBeVisible();
    await expect(transcript.locator("br")).toHaveCount(1);
    await expect(transcript.locator("em", { hasText: "Italic text" })).toBeVisible();
    await expect(transcript.locator("del", { hasText: "struck text" })).toBeVisible();
    await expect(
      transcript.locator("code.transcript-message__code", { hasText: "inline code" })
    ).toBeVisible();

    const codeBlock = transcript.locator("pre code");
    await expect(codeBlock).toContainText("**not bold**");
    await expect(codeBlock).toContainText("[$frontend-design]");
    await expect(codeBlock).toContainText("![Preview](https://example.com/inside-code.png)");
    await expect(transcript.locator("pre strong")).toHaveCount(0);
    await expect(transcript.locator("pre .skill-chip")).toHaveCount(0);
    await expect(transcript.locator("pre img")).toHaveCount(0);
    await expect(transcript.getByText("Back outside the block.")).toBeVisible();
  } finally {
    await app.close();
  }
});
