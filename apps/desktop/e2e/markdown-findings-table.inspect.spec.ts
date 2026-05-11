import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test.skip(
  process.env.PWRAGENT_E2E_INSPECT !== "1",
  "Set PWRAGENT_E2E_INSPECT=1 through the package script to run this manual inspector.",
);

test("opens the markdown table fixture until Electron is closed manually", async () => {
  test.setTimeout(0);

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/markdown-findings-table/replay.fixture.json",
    ),
    windowSize: {
      width: 1440,
      height: 900,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Sanitized Markdown table/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Sanitized Markdown table",
      }),
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(
      transcript.getByRole("link", { name: "InvoiceDispatcher.scala (line 48)" }),
    ).toBeVisible();

    console.log(
      [
        "",
        "Markdown table fixture is ready. Scroll through the transcript to inspect:",
        "  1. Wide review-findings table (tag / tag / label / prose / prose)",
        "  2. Compact key/value table (label / label) — easy case",
        "  3. Oversized 7-column regional matrix (label / prose x6) — overflow scroll",
        "  4. Status checklist (tag / tag / prose) — narrow values + prose",
        "  5. Alternate review schema (Severity / Module / Symptom / Fix)",
        "Close the Electron window or quit the app to finish this command.",
        "",
      ].join("\n"),
    );

    await Promise.race([
      app.window.waitForEvent("close", { timeout: 0 }).then(() => undefined),
      app.electronApp.waitForEvent("close", { timeout: 0 }).then(() => undefined),
    ]);
  } finally {
    await app.close().catch(() => undefined);
  }
});
