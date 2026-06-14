import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const threadMarkdownEdgeCasesSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function expectVisibleBlockGap(
  before: Locator,
  after: Locator,
): Promise<void> {
  const beforeBox = await before.boundingBox();
  const afterBox = await after.boundingBox();
  expect(beforeBox).not.toBeNull();
  expect(afterBox).not.toBeNull();
  expect(
    (afterBox?.y ?? 0) - ((beforeBox?.y ?? 0) + (beforeBox?.height ?? 0))
  ).toBeGreaterThan(6);
}

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

    const markdownLiteralBlock = transcript.locator("pre code").filter({
      hasText: "**not bold**",
    });
    await expect(markdownLiteralBlock).toHaveCount(1);
    await expect(markdownLiteralBlock).toContainText("[$frontend-design]");
    await expect(markdownLiteralBlock).toContainText(
      "![Preview](https://example.com/inside-code.png)"
    );
    await expect(transcript.locator("pre strong")).toHaveCount(0);
    await expect(transcript.locator("pre .skill-chip")).toHaveCount(0);
    await expect(transcript.locator("pre img")).toHaveCount(0);
    await expect(transcript.getByText("Back outside the block.")).toBeVisible();

    const codeBlocks = transcript.locator("pre code");
    await expect(codeBlocks).toHaveCount(2);
    const handoffBlock = codeBlocks.filter({ hasText: "Root cause:" });
    await expect(handoffBlock).toHaveCount(1);
    await expect(handoffBlock).toContainText("```swift");
    await expect(handoffBlock).toContainText("Regression test:");
    await expect(handoffBlock).toContainText("Related hardening from this investigation:");
    await expect(
      transcript.locator(".transcript-message__paragraph", { hasText: "Regression test:" })
    ).toHaveCount(0);

    await app.electronApp.evaluate(({ clipboard }) => {
      clipboard.writeText("");
    });

    await transcript
      .locator(".transcript-message__pre-wrap")
      .filter({ hasText: "Root cause:" })
      .getByRole("button", { name: "Copy code" })
      .click();
    await expect
      .poll(async () =>
        await app.electronApp.evaluate(({ clipboard }) => clipboard.readText())
      )
      .toContain("8. Asserts `representedRecording` is the currently selected recording.");

    const reply = app.window.getByRole("textbox", { name: "Reply" });
    await reply.focus();
    await app.window.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

    const composerInput = app.window.getByTestId("composer-tiptap-input");
    const composerEditor = app.window.locator(".composer-tiptap-input__editor");
    await expect(composerInput).toHaveAttribute(
      "data-value",
      /```swift\n\} else if button === uploadButton/,
    );
    await expect(composerInput).not.toHaveAttribute(
      "data-value",
      /```swift\n\n\} else if button === uploadButton/,
    );
    await expect(composerInput).not.toHaveAttribute(
      "data-value",
      /uploadButtonClicked\(\)\n\n\}/,
    );
    await expect(composerInput).toHaveAttribute(
      "data-value",
      /videos" bug\.\n\nRoot cause:\n\nAfter selecting multiple reel items/,
    );
    await expect(composerInput).toHaveAttribute(
      "data-value",
      /silently fell through and did nothing\.\n\nFix:\n\nIn `GGEditorOptionsViewController\.giphyButtonClicked\(_:\)`/,
    );
    await expect(composerInput).not.toHaveAttribute(
      "data-value",
      /videos" bug\.\n\nRoot cause:\nAfter selecting multiple reel items/,
    );
    await expect(composerInput).not.toHaveAttribute(
      "data-value",
      /silently fell through and did nothing\.\n\nFix:\nIn `GGEditorOptionsViewController\.giphyButtonClicked\(_:\)`/,
    );
    await expectVisibleBlockGap(
      composerEditor.locator("> p", { hasText: /^Root cause:$/ }),
      composerEditor.locator("> p", { hasText: /^After selecting multiple reel items/ }),
    );
    await expectVisibleBlockGap(
      composerEditor.locator("> p", { hasText: /^Fix:$/ }),
      composerEditor.locator("> p", {
        hasText: /^In GGEditorOptionsViewController\.giphyButtonClicked/,
      }),
    );
    await expect(composerEditor.locator("ol > li")).toHaveCount(8);
    await expect(composerEditor.locator("ul > li")).toHaveCount(3);
    await expect(composerInput).toHaveAttribute(
      "data-value",
      /Add a test that:\n\n1\. Creates several ready recordings\.\n2\. Adds them to `GGDataStore`\./,
    );
    await expect(composerInput).not.toHaveAttribute(
      "data-value",
      /1\. Creates several ready recordings\.\n\n2\. Adds them to `GGDataStore`\./,
    );
    await expect(composerInput).toHaveAttribute(
      "data-value",
      /Related hardening from this investigation:\n\n- Add diagnostic logs[\s\S]*\n- Make `GGUploadWindowController\.close\(\)`/,
    );
    await expect(composerInput).not.toHaveAttribute(
      "data-value",
      /- Add diagnostic logs[\s\S]*\n\n- Make `GGUploadWindowController\.close\(\)`/,
    );
  } finally {
    await app.close();
  }
});
