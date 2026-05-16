import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const FULL_RELEASE_MESSAGE =
  "The test run has two failures in the Codex environment runtime area while the suite is still finishing; typecheck is still running too. I’ll wait for full output before deciding whether it’s a real release blocker or the known temp/worktree interaction pattern.";
const PARTIAL_RELEASE_MESSAGE =
  "is still running too. I’ll wait for full output before deciding whether it’s a real release blocker or the known temp/worktree interaction pattern.";

test("renders completed assistant commentary from the full agentMessage item", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/release-transcript-agent-message-completion/replay.fixture.json"
    ),
    windowSize: {
      width: 1440,
      height: 820,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /PwrAgent - Release transcript repro/i })
      .first()
      .click();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript).toContainText("Ship the beta release");

    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "activity-completed-1" });
    await app.advance({ stepId: "assistant-message-partial-delta" });
    await expect(transcript).toContainText(PARTIAL_RELEASE_MESSAGE);
    await expect(transcript).not.toContainText(FULL_RELEASE_MESSAGE);

    await app.advance({ stepId: "assistant-message-completed" });
    await expect(transcript).toContainText(FULL_RELEASE_MESSAGE);

    const assistantText = await transcript
      .locator(".transcript-message--assistant .transcript-message__text")
      .last()
      .innerText();
    expect(assistantText).toBe(FULL_RELEASE_MESSAGE);
  } finally {
    await app.close();
  }
});
