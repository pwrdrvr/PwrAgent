import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const transcriptActivityOrderSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("tool activity stays in protocol order when transcript work is collapsed", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      transcriptActivityOrderSpecDir,
      "fixtures/transcript-activity-order/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Transcript activity ordering/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Transcript activity ordering"
      })
    ).toBeVisible();

    const transcriptText = await app.window
      .getByRole("region", { name: "Transcript" })
      .innerText();
    const userIndex = transcriptText.indexOf("Replay the captured order.");
    const firstActivityIndex = transcriptText.indexOf("Worked for 1m 10s");
    const interimIndex = transcriptText.indexOf("Interim answer after the first tool.");
    const secondActivityIndex = transcriptText.indexOf("More work", interimIndex + 1);
    const finalIndex = transcriptText.indexOf("Done.");

    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(firstActivityIndex).toBeGreaterThan(userIndex);
    expect(interimIndex).toBeGreaterThan(firstActivityIndex);
    expect(secondActivityIndex).toBeGreaterThan(interimIndex);
    expect(finalIndex).toBeGreaterThan(secondActivityIndex);

    await app.window.getByRole("button", { name: /Worked for 1m 10s/ }).first().click();
    await app.window.getByRole("button", { name: /Explored 1 file/ }).first().click();
    await expect(app.window.getByText("Read a.ts (1.2s)")).toBeVisible();
    await expect(app.window.getByText("Read b.ts (2.5s)")).toBeHidden();

    await app.window.getByRole("button", { name: /More work/ }).click();
    await app.window.getByRole("button", { name: /Explored 1 file/ }).last().click();
    await expect(app.window.getByText("Read b.ts (2.5s)")).toBeVisible();
  } finally {
    await app.close();
  }
});
