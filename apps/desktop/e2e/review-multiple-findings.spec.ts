import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("renders captured Codex review findings as separate cards without duplicates", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/review-multiple-findings/replay.fixture.json"
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /Steering/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Steering",
      })
    ).toBeVisible();

    await app.window.getByLabel("Reply").fill("/review main");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(async () => await app.getLastStartReview())
      .toMatchObject({
        threadId: "019dd4ce-4fec-76c0-8ede-5e65d7377417",
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
      "The patch can lose pending steer drafts in realistic active-turn races."
    );
    await expect(reviewCard).toContainText(
      "Only clear steer after it has actually been sent"
    );
    await expect(reviewCard).toContainText(
      "Preserve pending steer when a queued turn already exists"
    );
    await expect(reviewCard.getByText("P2")).toHaveCount(2);
    await expect(reviewCard).toContainText("Lines 618-622");
    await expect(reviewCard).toContainText("Lines 660-667");

    await expect(
      transcript.getByText("Only clear steer after it has actually been sent")
    ).toHaveCount(1);
    await expect(
      transcript.getByText("Preserve pending steer when a queued turn already exists")
    ).toHaveCount(1);
    await expect(
      transcript.getByText("The patch can lose pending steer drafts in realistic active-turn races.")
    ).toHaveCount(1);
    await expect(transcript.getByText("Full review comments:")).toHaveCount(0);
    await expect(transcript.getByText("changes against 'main'")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
