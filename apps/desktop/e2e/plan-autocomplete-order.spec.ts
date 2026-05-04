import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("keeps active work activity before later live commentary", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/plan-autocomplete-order/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Plan autocomplete ordering replay/i })
      .first()
      .click();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript).toContainText("Ready to continue plan autocomplete coverage.");

    await app.window.getByLabel("Reply").fill("Keep going.");
    await app.window.getByRole("button", { name: "Send" }).click();

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "typecheck-started-1" });
    await app.advance({ stepId: "vitest-started-1" });
    await app.advance({ stepId: "vitest-completed-1" });
    await app.advance({ stepId: "typecheck-completed-1" });
    await app.advance({ stepId: "file-change-1" });
    await app.advance({ stepId: "assistant-focused-tests-1" });
    await app.advance({ stepId: "e2e-started-1" });
    await app.advance({ stepId: "e2e-completed-1" });
    await app.advance({ stepId: "assistant-electron-1" });

    await expect(transcript.getByText("The focused composer tests")).toBeVisible();
    await expect(transcript.getByText("Electron showed the plain contenteditable route")).toBeVisible();
    await expect(transcript.getByText("Changed 1 file")).toBeVisible();

    const transcriptText = await transcript.innerText();
    const commandIndex = transcriptText.indexOf("Used 2 tools");
    const changedIndex = transcriptText.indexOf("Changed 1 file");
    const focusedMessageIndex = transcriptText.indexOf("The focused composer tests");
    const e2eCommandIndex = transcriptText.indexOf(
      "pnpm --filter @pwragent/desktop test"
    );
    const electronMessageIndex = transcriptText.indexOf(
      "Electron showed the plain contenteditable route"
    );

    expect(commandIndex).toBeGreaterThanOrEqual(0);
    expect(changedIndex).toBeGreaterThan(commandIndex);
    expect(focusedMessageIndex).toBeGreaterThan(changedIndex);
    expect(e2eCommandIndex).toBeGreaterThan(focusedMessageIndex);
    expect(electronMessageIndex).toBeGreaterThan(e2eCommandIndex);
  } finally {
    await app.close();
  }
});
