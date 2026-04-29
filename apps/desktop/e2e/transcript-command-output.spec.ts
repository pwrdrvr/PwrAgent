import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const transcriptCommandOutputSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("captured command output is inspectable from transcript work", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      transcriptCommandOutputSpecDir,
      "fixtures/transcript-command-output/replay.fixture.json"
    ),
    windowSize: {
      width: 1280,
      height: 900,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Transcript command output/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Transcript command output",
      })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript.getByText("dive@0.5.0 | Proprietary")).toBeHidden();

    const transcriptText = await transcript.innerText();
    const userIndex = transcriptText.indexOf("Run npm view dive.");
    const activityIndex = transcriptText.indexOf("Previous work");
    const finalIndex = transcriptText.indexOf("npm view dive completed successfully.");

    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeGreaterThan(userIndex);
    expect(finalIndex).toBeGreaterThan(activityIndex);

    await app.window.getByRole("button", { name: /Previous work/ }).click();
    await app.window.getByRole("button", { name: /npm view dive \(373ms\)/ }).click();

    await expect(transcript.getByText("$ npm view dive")).toBeVisible();
    await expect(transcript.getByText(/dive@0\.5\.0 \| Proprietary/)).toBeVisible();
    await expect(transcript.getByText(/https:\/\/github\.com\/pvorb\/node-dive#readme/)).toBeVisible();
    await expect(transcript.getByText("Success · ran for 373ms")).toBeVisible();
  } finally {
    await app.close();
  }
});
