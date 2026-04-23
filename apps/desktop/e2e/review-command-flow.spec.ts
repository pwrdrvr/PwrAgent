import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const reviewCommandSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("review command asks for target and preserves transcript order", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      reviewCommandSpecDir,
      "fixtures/review-command-flow/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Review command flow/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Review command flow"
      })
    ).toBeVisible();

    await app.window.getByLabel("Reply").fill("/review");
    await app.window.getByRole("button", { name: "Send" }).click();

    const reviewTarget = app.window.getByRole("group", { name: "Review target" });
    await expect(reviewTarget).toBeVisible();
    await expect
      .poll(async () => await app.getLastStartReview())
      .toBeUndefined();

    await reviewTarget.getByRole("button", { name: /Base branch/ }).click();
    await reviewTarget.getByLabel("Base branch").fill("main");
    await reviewTarget.getByRole("button", { name: "Start review" }).click();

    await expect
      .poll(async () => await app.getLastStartReview())
      .toMatchObject({
        threadId: "thread-review-command",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript.getByText("Review changes against main")).toBeVisible();

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-completed-1" });

    await expect(transcript.getByText("Code review")).toBeVisible();
    await expect(
      transcript.getByText("No findings. The branch comparison is ready to merge.")
        .first()
    ).toBeVisible();
    await expect(
      transcript.getByText(
        "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings."
      )
    ).toHaveCount(0);

    const transcriptText = await transcript.innerText();
    expect(transcriptText.indexOf("Ready for review command coverage.")).toBeGreaterThan(-1);
    expect(transcriptText.indexOf("Review changes against main")).toBeGreaterThan(
      transcriptText.indexOf("Ready for review command coverage.")
    );
    expect(transcriptText.indexOf("Code review")).toBeGreaterThan(
      transcriptText.indexOf("Review changes against main")
    );
    expect(
      transcriptText.indexOf("No findings. The branch comparison is ready to merge.")
    ).toBeGreaterThan(transcriptText.indexOf("Code review"));
  } finally {
    await app.close();
  }
});
