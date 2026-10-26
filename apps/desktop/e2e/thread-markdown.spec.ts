import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { mastheadAction } from "./fixtures/window-chrome";
import { applyDesktopSettingsPatch } from "../src/main/settings/desktop-config";

const threadMarkdownSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("renders markdown content in transcript messages (standard)", () => assertMarkdownRendering(false));
test("renders markdown content in transcript messages (incremental)", () => assertMarkdownRendering(true));

async function assertMarkdownRendering(incrementalEnabled: boolean) {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      threadMarkdownSpecDir,
      "fixtures/thread-markdown/replay.fixture.json"
    ),
    preLaunchHook: (homeRoot) => {
      applyDesktopSettingsPatch(path.join(homeRoot, ".pwragent/profiles/default/config.toml"), {
        experimental: { incrementalMarkdownRendering: incrementalEnabled },
      });
    },
  });

  try {
    const parsedScripts = new Set<string>();
    const cdp = await app.window.context().newCDPSession(app.window);
    cdp.on("Debugger.scriptParsed", ({ url }) => parsedScripts.add(url));
    // Resource Timing omits file:// modules. Debugger.enable also reports
    // scripts parsed before attachment, including an already-loaded renderer.
    await cdp.send("Debugger.enable");

    // Startup may already have opened the replay thread. Leave it explicitly
    // so the assertions below exercise a fresh transcript mount in either case.
    await mastheadAction(app.window, "New thread").click();
    await expect(app.window.getByRole("heading", { level: 2, name: "New thread" }))
      .toBeVisible();
    await expect(app.window.getByRole("heading", { name: "Transcript heading 1", exact: true }))
      .toHaveCount(0);

    // Wait for the provider's committed context before mounting the transcript.
    // A parsed chunk alone does not prove the provider has adopted it, and
    // settled documents keep the renderer they mounted with until text changes.
    await expect(app.window.locator(".thread-view[data-markdown-renderer-available]"))
      .toHaveAttribute("data-markdown-renderer-available", incrementalEnabled ? "incremental" : "standard");

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

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(
      transcript.locator(".skill-chip", { hasText: "$frontend-design" })
    ).toBeVisible();
    const explicitSkillChip = transcript.locator("[data-skill-chip]", {
      hasText: "ce:work",
    });
    await expect(explicitSkillChip).toBeVisible();
    await expect(explicitSkillChip).toHaveAttribute("draggable", "false");
    await expect(transcript.getByRole("link", { name: "ce:work" })).toHaveCount(0);
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
    // Read all six heading styles from one snapshot of the current DOM.
    await expect.poll(async () => {
      const styles = await transcript.evaluate(readTranscriptHeadingStyles);
      return {
        found: styles.filter(Boolean).length,
        sizesDecrease: styles.every((style, index) =>
          style !== null
          && (index === 0 || styles[index - 1]!.fontSize > style.fontSize)
        ),
        h5FontStyle: styles[4]?.fontStyle,
        h6FontStyle: styles[5]?.fontStyle,
        styles,
      };
    }).toMatchObject({
      found: 6,
      sizesDecrease: true,
      h5FontStyle: "italic",
      h6FontStyle: "italic",
    });
    await expect(transcript.getByText("Preserves file links")).toBeVisible();
    await expect(transcript).toContainText("Keeps");
    await expect(transcript).toContainText("inert");
    await expect.poll(() => [...parsedScripts].some((url) =>
      url.includes("/IncrementalMarkdown-")
    )).toBe(incrementalEnabled);
  } finally {
    await app.close();
  }
}

function readTranscriptHeadingStyles(transcript: Element) {
  return [1, 2, 3, 4, 5, 6].map((level) => {
    const heading = Array.from(
      transcript.querySelectorAll(`h${level}.transcript-message__heading`)
    ).find((element) =>
      element.textContent?.includes(`Transcript heading ${level}`)
    );
    if (!heading) {
      return null;
    }
    const styles = getComputedStyle(heading);
    return {
      fontSize: Number.parseFloat(styles.fontSize),
      fontStyle: styles.fontStyle,
    };
  });
}
