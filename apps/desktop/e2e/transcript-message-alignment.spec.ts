import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

async function expectMessageDocked(params: {
  message: Locator;
  side: "left" | "right";
}) {
  await expect(params.message).toBeVisible();

  await expect
    .poll(async () =>
      await params.message.evaluate((messageElement, side) => {
        const listElement = messageElement.closest(".transcript-list__items");
        if (!listElement) {
          throw new Error("Expected transcript message inside transcript list");
        }

        const listRect = listElement.getBoundingClientRect();
        const messageRect = messageElement.getBoundingClientRect();

        const leftGap = Math.round(messageRect.left - listRect.left);
        const rightGap = Math.round(listRect.right - messageRect.right);

        return side === "left" ? leftGap < rightGap : rightGap < leftGap;
      }, params.side)
    )
    .toBe(true);
}

test("visually docks user messages right and assistant messages left", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-agent-messages/replay.fixture.json"
    ),
    windowSize: {
      width: 1440,
      height: 900,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Telegram brainstorm replay/i })
      .first()
      .click();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const assistantMessage = transcript
      .locator(".transcript-message--assistant")
      .filter({ hasText: "Ready to brainstorm Telegram support." })
      .first();

    await expectMessageDocked({
      message: assistantMessage,
      side: "left",
    });

    await app.window
      .getByLabel("Reply")
      .fill("What would it take to add Telegram support?");
    await app.window.getByRole("button", { name: "Send" }).click();

    const userMessage = transcript
      .locator(".transcript-message--user")
      .filter({ hasText: "What would it take to add Telegram support?" })
      .first();

    await expectMessageDocked({
      message: userMessage,
      side: "right",
    });

    const alignment = {
      assistantLeft: await assistantMessage.evaluate((message) =>
        Math.round(message.getBoundingClientRect().left)
      ),
      userLeft: await userMessage.evaluate((message) =>
        Math.round(message.getBoundingClientRect().left)
      ),
    };

    expect(alignment.userLeft).toBeGreaterThan(alignment.assistantLeft);
  } finally {
    await app.close();
  }
});
