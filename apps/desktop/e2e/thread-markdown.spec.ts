import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "./fixtures/electron-test";
import { launchElectronApp, resolveSeedConfigPath } from "./fixtures/electron-app";
import { mastheadAction } from "./fixtures/window-chrome";
import { applyDesktopSettingsPatch } from "../src/main/settings/desktop-config";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

const threadMarkdownSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("renders transcript Markdown in both modes through one Electron launch", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      threadMarkdownSpecDir,
      "fixtures/thread-markdown/replay.fixture.json"
    ),
    preLaunchHook: (homeRoot) => {
      applyDesktopSettingsPatch(resolveSeedConfigPath({ HOME: homeRoot }), {
        general: { markdown: { incrementalRendering: false } },
      });
    },
  });

  try {
    const observeIncrementalChunk = async () => {
      const cdp = await app.window.context().newCDPSession(app.window);
      let parsed = false;
      cdp.on("Debugger.scriptParsed", ({ url }) => {
        if (url.includes("/IncrementalMarkdown-")) parsed = true;
      });
      // Resource Timing omits file:// modules. Debugger.enable also reports
      // scripts parsed before attachment in the current document.
      await cdp.send("Debugger.enable");
      return { cdp, hasChunk: () => parsed };
    };
    const initial = await observeIncrementalChunk();
    const readBootstrapPreference = () => app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.readConfigBootstrap!()).snapshot?.markdown?.incrementalRendering;
    });

    const assertMode = async (mode: "incremental" | "standard") => {
      // Leave the thread first. Settled documents keep their renderer until
      // they remount or their text changes.
      await mastheadAction(app.window, "New thread").click();
      await expect(app.window.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();
      await expect(app.window.getByRole("heading", { name: "Transcript heading 1", exact: true }))
        .toHaveCount(0);
      await expect(app.window.locator(".thread-view[data-markdown-renderer-available]"))
        .toHaveAttribute("data-markdown-renderer-available", mode);
      await app.window.getByRole("button", { name: /Markdown replay thread/i }).first().click();
      await expect(app.window.getByRole("heading", { level: 2, name: "Markdown replay thread" }))
        .toBeVisible();
      await assertTranscript(app.window.getByRole("region", { name: "Transcript" }));
    };

    await test.step("saved opt-out keeps the packaged chunk unloaded at cold start", async () => {
      expect(await readBootstrapPreference()).toBe(false);
      await assertMode("standard");
      expect(initial.hasChunk()).toBe(false);
    });

    await test.step("enabling incremental mode loads the packaged chunk", async () => {
      await app.window.getByRole("button", { name: "Open settings", exact: true }).click();
      const nav = app.window.getByRole("navigation", { name: "Settings sections" });
      await nav.getByRole("button", { name: "General", exact: true }).click();
      const toggle = app.window.getByRole("region", { name: "Markdown rendering", exact: true })
        .getByRole("switch", { name: "Incremental rendering", exact: true });
      await expect(toggle).not.toBeChecked();
      expect(initial.hasChunk()).toBe(false);
      await toggle.click();
      await expect(toggle).toBeChecked();
      await nav.getByRole("button", { name: /Exit Settings/i }).click();
      await expect(nav).toBeHidden();
      await assertMode("incremental");
      await expect.poll(initial.hasChunk).toBe(true);
    });

    await test.step("saved opt-in loads the packaged chunk in a fresh renderer", async () => {
      await expect.poll(readBootstrapPreference).toBe(true);
      await initial.cdp.detach();
      await app.window.reload();
      const restarted = await observeIncrementalChunk();
      await assertMode("incremental");
      await expect.poll(restarted.hasChunk).toBe(true);
    });
  } finally {
    await app.close();
  }
});

async function assertTranscript(transcript: Locator) {
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
