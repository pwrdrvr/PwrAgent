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
    const headingLocators = [1, 2, 3, 4, 5, 6].map((level) =>
      transcript.locator(`h${level}.transcript-message__heading`, {
        hasText: `Transcript heading ${level}`,
      })
    );
    for (const heading of headingLocators) {
      await expect(heading).toBeVisible();
    }
    const headingStyles = await Promise.all(
      headingLocators.map((heading) =>
        heading.evaluate((element) => {
          const styles = getComputedStyle(element);
          return {
            fontSize: Number.parseFloat(styles.fontSize),
            fontStyle: styles.fontStyle,
          };
        })
      )
    );
    for (let index = 1; index < headingStyles.length; index += 1) {
      expect(headingStyles[index - 1].fontSize).toBeGreaterThan(
        headingStyles[index].fontSize
      );
    }
    expect(headingStyles[4].fontStyle).toBe("italic");
    expect(headingStyles[5].fontStyle).toBe("italic");
    await expect(transcript.getByText("Preserves file links")).toBeVisible();
    await expect(transcript).toContainText("Keeps");
    await expect(transcript).toContainText("inert");
  } finally {
    await app.close();
  }
});
