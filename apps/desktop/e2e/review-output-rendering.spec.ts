import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("renders captured Codex review findings once in the review card", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/review-output-rendering/replay.fixture.json"
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /Composer image paste reset E2E/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Composer image paste reset E2E",
      })
    ).toBeVisible();

    await app.window.getByLabel("Reply").fill("/review main");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(async () => await app.getLastStartReview())
      .toMatchObject({
        threadId: "019dd682-56d6-7601-8634-fc3a49e67554",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await app.advance({ stepId: "review-entered-started-1" });
    await app.advance({ stepId: "review-entered-completed-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "review-exited-started-1" });
    await app.advance({ stepId: "review-exited-completed-1" });
    await app.advance({ stepId: "review-assistant-started-1" });
    await app.advance({ stepId: "review-assistant-completed-1" });
    await app.advance({ stepId: "turn-completed-1" });

    const reviewCard = transcript.getByRole("group", { name: "Code review" }).last();
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard).toContainText(
      "The thread draft preservation path fixes the covered scenario"
    );
    await expect(reviewCard.getByText("P2")).toBeVisible();
    await expect(reviewCard).toContainText(
      "Preserve async pasted images for launchpad scopes"
    );
    await expect(reviewCard).toContainText("features/composer/Composer.tsx");
    await expect(reviewCard).toContainText("Lines 971-979");

    await expect(
      transcript.getByText("Preserve async pasted images for launchpad scopes")
    ).toHaveCount(1);
    await expect(
      transcript.getByText("The thread draft preservation path fixes the covered scenario")
    ).toHaveCount(1);
    await expect(transcript.getByText("Review changes against main")).toHaveCount(1);
    await expect(transcript.getByText("changes against 'main'")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
