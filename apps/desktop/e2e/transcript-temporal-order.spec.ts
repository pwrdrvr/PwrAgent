import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("transcript preserves temporal order across live activity and hydration", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/transcript-temporal-order/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Transcript temporal ordering/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Transcript temporal ordering"
      })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript).toContainText("Show the temporal transcript order.");

    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "assistant-message-1" });
    await app.advance({ stepId: "tool-read-started-1" });
    await app.advance({ stepId: "assistant-message-2" });
    await app.advance({ stepId: "tool-search-started-1" });
    await app.advance({ stepId: "assistant-message-3" });

    await expect(transcript).toContainText("The code already logs explicit turn completion.");
    await expect(transcript).toContainText("I am going to close that gap in renderBindingStatus.");
    await expect(transcript).toContainText("I added the controller hook that reconciles navigation state.");

    let transcriptText = await transcript.innerText();
    assertOrdered(transcriptText, [
      "Show the temporal transcript order.",
      "The code already logs explicit turn completion.",
      "I am going to close that gap in renderBindingStatus.",
      "I added the controller hook that reconciles navigation state.",
    ]);
    expect(countOccurrences(transcriptText, "Working for")).toBeLessThanOrEqual(1);

    await app.advance({ stepId: "turn-completed-1" });

    await expect(transcript.getByText("I added the controller hook")).toBeVisible();
    transcriptText = await transcript.innerText();
    assertOrdered(transcriptText, [
      "Show the temporal transcript order.",
      "The code already logs explicit turn completion.",
      "Worked for 1m 10s",
      "I am going to close that gap in renderBindingStatus.",
      "More work",
      "I added the controller hook that reconciles navigation state.",
    ]);

    await transcript.getByRole("button", { name: /Worked for 1m 10s/ }).click();
    await transcript.getByRole("button", { name: /More work/ }).click();
    await transcript.getByRole("button", { name: /Explored 1 item/ }).first().click();
    await transcript.getByRole("button", { name: /Explored 1 item/ }).last().click();

    await expect(transcript.getByText("Read useThreadSessionState.ts")).toBeVisible();
    await expect(transcript.getByText("Searched thread-detail")).toBeVisible();
    transcriptText = await transcript.innerText();
    assertOrdered(transcriptText, [
      "The code already logs explicit turn completion.",
      "Read useThreadSessionState.ts",
      "I am going to close that gap in renderBindingStatus.",
      "Searched thread-detail",
      "I added the controller hook that reconciles navigation state.",
    ]);
  } finally {
    await app.close();
  }
});

function assertOrdered(text: string, labels: string[]): void {
  let previousIndex = -1;
  for (const label of labels) {
    const nextIndex = text.indexOf(label, previousIndex + 1);
    expect(nextIndex, `Expected "${label}" after index ${previousIndex}`).toBeGreaterThan(
      previousIndex
    );
    previousIndex = nextIndex;
  }
}

function countOccurrences(text: string, label: string): number {
  return text.split(label).length - 1;
}
