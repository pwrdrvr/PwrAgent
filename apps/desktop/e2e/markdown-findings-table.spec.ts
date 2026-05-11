import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("renders a wide assistant markdown findings table without crushing the columns", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/markdown-findings-table/replay.fixture.json"
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
      })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const proseMessage = transcript
      .locator(".transcript-message--assistant")
      .filter({ hasText: "Verdict: Not ready for enforcement" })
      .first();
    const wideTableMessage = transcript
      .locator(".transcript-message--table-wide")
      .filter({ hasText: "InvoiceDispatcher.scala" })
      .first();
    const tableScroll = wideTableMessage.locator(".thread-markdown__table-scroll");
    const table = tableScroll.locator("table.thread-markdown__table");

    await expect(proseMessage).toBeVisible();
    await expect(proseMessage).not.toHaveClass(/transcript-message--table-wide/);
    await expect(wideTableMessage).toBeVisible();
    await expect(tableScroll).toBeVisible();
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "#" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Sev" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "File" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Issue" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Fix" })).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(5);
    await expect(table.getByRole("link", { name: "InvoiceDispatcher.scala (line 48)" })).toBeVisible();
    await expect(table).toContainText("Retry suppressed");
    await expect(table).toContainText("failure-heavy behavior explicitly");

    const dimensions = await tableScroll.evaluate((node) => {
      const tableNode = node.querySelector("table");
      const headerKinds = Array.from(node.querySelectorAll("thead th")).map((th) =>
        th.getAttribute("data-col-kind")
      );
      const linkNode = node.querySelector("tbody tr:first-child td:nth-child(3) a");
      const fileCell = node.querySelector("tbody tr:first-child td:nth-child(3)");
      const issueCell = node.querySelector("tbody tr:first-child td:nth-child(4)");
      return {
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        assistantWidth: node.closest(".transcript-message")?.getBoundingClientRect().width ?? 0,
        tableWidth: tableNode?.getBoundingClientRect().width ?? 0,
        fileCellWidth: fileCell?.getBoundingClientRect().width ?? 0,
        fileLinkWidth: linkNode?.getBoundingClientRect().width ?? 0,
        issueCellWidth: issueCell?.getBoundingClientRect().width ?? 0,
        headerKinds,
      };
    });

    expect(dimensions.assistantWidth).toBeGreaterThan(880);
    // Content-aware profile for the canonical review-findings header
    expect(dimensions.headerKinds).toEqual(["tag", "tag", "label", "prose", "prose"]);
    // File column is profiled as `label` and should host the full filename
    // on a single line rather than wrapping character-by-character
    expect(dimensions.fileLinkWidth).toBeGreaterThan(120);
    expect(dimensions.fileCellWidth).toBeGreaterThan(180);
    // Issue column is profiled as `prose` and gets a generous prose floor
    expect(dimensions.issueCellWidth).toBeGreaterThan(180);

    const compactTableMessage = transcript
      .locator(".transcript-message--assistant")
      .filter({ hasText: "Compact summary:" })
      .first();
    await expect(compactTableMessage).toBeVisible();
    await expect(compactTableMessage).not.toHaveClass(/transcript-message--table/);
    await expect(compactTableMessage).not.toHaveClass(/transcript-message--table-wide/);
    await expect(compactTableMessage.locator("table")).toContainText("Billing");

    const oversizedTableScroll = transcript
      .locator(".transcript-message--table-wide")
      .filter({ hasText: "north-america-invoice-pacing-window-retry-suppressed-001" })
      .locator(".thread-markdown__table-scroll")
      .first();
    await expect(oversizedTableScroll).toBeVisible();
    const oversizedDimensions = await oversizedTableScroll.evaluate((node) => {
      const headers = Array.from(node.querySelectorAll("thead th")).map((header) =>
        header.getBoundingClientRect()
      );

      return {
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        tableWidth: node.querySelector("table")?.getBoundingClientRect().width ?? 0,
        metricWidth: headers[0]?.width ?? 0,
        northAmericaWidth: headers[1]?.width ?? 0,
        metricRight: headers[0]?.right ?? 0,
        northAmericaLeft: headers[1]?.left ?? 0,
        northAmericaRight: headers[1]?.right ?? 0,
        europeLeft: headers[2]?.left ?? 0,
      };
    });
    expect(oversizedDimensions.scrollWidth).toBeGreaterThan(
      oversizedDimensions.clientWidth + 120
    );
    expect(oversizedDimensions.tableWidth).toBeGreaterThan(
      oversizedDimensions.clientWidth + 120
    );
    expect(oversizedDimensions.metricWidth).toBeGreaterThan(120);
    expect(oversizedDimensions.northAmericaWidth).toBeGreaterThan(140);
    expect(oversizedDimensions.metricRight).toBeLessThanOrEqual(
      oversizedDimensions.northAmericaLeft + 1
    );
    expect(oversizedDimensions.northAmericaRight).toBeLessThanOrEqual(
      oversizedDimensions.europeLeft + 1
    );
  } finally {
    await app.close();
  }
});
