import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const harnessTableBlock = `## Quick matrix

---

| Harness | Executable | Primary install | First run |
|---|---|---|---|
| Grok Build | \`grok\` | Shell installer on macOS/Linux; PowerShell installer on Windows | Browser sign-in or API key |
| Kimi Code | \`kimi\` | Vendor installer, with Git for Windows on native Windows | Run \`/login\` in the TUI |
| Qwen Code | \`qwen\` | Standalone installer; package-manager fallback needs Node 22+ | Run \`/auth\` in the session |
| Codex CLI | \`codex\` | Standalone installer for macOS, Linux, and Windows | Sign in with ChatGPT or provide an API key |`;
const harnessMessage = `Research is complete. This is a compact cross-platform setup guide for the public harnesses.

${harnessTableBlock}

Implementation note: keep the matrix horizontally scrollable without widening the transcript.`;

test("renders a wide assistant markdown findings table without crushing the columns", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/markdown-findings-table/replay.fixture.json"
    ),
    windowSize: {
      width: 1440,
      // This spec validates wide transcript/table layout; height is not part
      // of the assertion. Keep it below Linux CI's observed 873px content cap
      // so the shared launcher can still assert the requested viewport exactly.
      height: 860,
    },
    // This spec asserts on the full-width transcript layout; unpin the
    // (default pinned-open) context rail so it doesn't narrow the assistant
    // column under test.
    contextRailPinned: false,
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
    await expect(
      wideTableMessage.getByRole("heading", { level: 2, name: "Findings" })
    ).toBeVisible();
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

    // One evaluate for both widths, because the assertion below compares
    // them to each other. Read separately they can straddle a reflow, and
    // then the comparison is between two different layouts rather than
    // between two columns.
    //
    // That is not hypothetical. `Windows Desktop E2E (lane 3 of 4)` failed
    // twice with `assistantWidth=566` against `proseWidth=760` — and a wide
    // message cannot be narrower than a prose one in any single layout:
    // `.transcript-message` is `width: min(100%, 760px)` capped at
    // `max-width: 84%`, `.transcript-message--table-wide` is `width: 100%`,
    // so the wide one is the container and the prose one is at most 84% of
    // it. 760px of prose needs a container of at least 905px; the table saw
    // 566. The transcript column therefore grew by ~340px between the two
    // reads, which is the context rail unpinning — this spec asks for
    // `contextRailPinned: false`, and that used to arrive with the settings
    // snapshot rather than at first paint.
    const proseHandle = await proseMessage.elementHandle();
    expect(proseHandle).not.toBeNull();
    const dimensions = await tableScroll.evaluate((node, prose) => {
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
        proseWidth: (prose as HTMLElement).getBoundingClientRect().width,
        headerKinds,
      };
    }, proseHandle);

    // The breakout is the feature: a wide table escapes the column every
    // other assistant message sits in. Measured against that column rather
    // than a pixel constant, because the constant encoded one runner's window
    // size — 880 passed on macOS and reported 566 on the 1024px-wide Windows
    // runner, where the breakout was working exactly as designed.
    //
    // 1.15 is below the narrowest ratio the stylesheet can produce and above
    // 1. A plain message is `min(100%, 760px)` capped at `max-width: 84%`; a
    // wide one is the full 100%. So the ratio is 1/0.84 = 1.19 on any
    // container under 904px and grows from there as 760px stops binding.
    // A handle resolved before the evaluate can be detached by a re-render,
    // and a detached node's rect is all zeros — which would turn the ratio
    // below into `assistantWidth > 0` and pass against the very layout this
    // spec exists to reject.
    expect(dimensions.proseWidth).toBeGreaterThan(0);
    expect(dimensions.assistantWidth).toBeGreaterThan(dimensions.proseWidth * 1.15);
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

    const harnessProseMessage = transcript
      .locator(".transcript-message--assistant")
      .filter({ hasText: "Research is complete" })
      .first();
    const harnessTableMessage = transcript
      .locator(".transcript-message--table-wide")
      .filter({ hasText: "Quick matrix" })
      .first();
    await expect(harnessProseMessage).toBeVisible();
    await expect(harnessProseMessage).not.toContainText("Quick matrix");
    await expect(harnessTableMessage).toBeVisible();
    await expect(
      harnessTableMessage.getByRole("heading", { level: 2, name: "Quick matrix" })
    ).toBeVisible();
    await expect(harnessTableMessage.locator(".transcript-message__rule")).toBeVisible();
    await expect(harnessTableMessage.locator("table")).toContainText("Grok Build");

    await harnessTableMessage
      .getByRole("button", { name: "Copy table block" })
      .click();
    await expect
      .poll(async () => await app.getClipboardSnapshot())
      .toMatchObject({ text: harnessTableBlock });

    await harnessProseMessage
      .getByRole("button", { name: "Copy message" })
      .click();
    await expect
      .poll(async () => await app.getClipboardSnapshot())
      .toMatchObject({ text: harnessMessage });
  } finally {
    await app.close();
  }
});
