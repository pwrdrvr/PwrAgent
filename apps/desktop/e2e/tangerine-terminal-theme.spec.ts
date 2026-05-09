import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const themeSpecDir = path.dirname(fileURLToPath(import.meta.url));

type Rgb = {
  blue: number;
  green: number;
  red: number;
};

function parseRgb(value: string): Rgb {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) {
    throw new Error(`Expected CSS rgb() color, got: ${value}`);
  }

  return {
    red: Number.parseInt(match[1], 10),
    green: Number.parseInt(match[2], 10),
    blue: Number.parseInt(match[3], 10),
  };
}

function relativeLuminance(color: Rgb): number {
  const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);

  return (lighter + 0.05) / (darker + 0.05);
}

async function computedStyle(locator: Locator, property: string): Promise<string> {
  return await locator.evaluate((element, styleProperty) =>
    getComputedStyle(element).getPropertyValue(styleProperty).trim(),
  property);
}

async function computedPseudoStyle(
  locator: Locator,
  pseudoElement: string,
  property: string
): Promise<string> {
  return await locator.evaluate(
    (element, params) =>
      getComputedStyle(element, params.pseudoElement)
        .getPropertyValue(params.property)
        .trim(),
    { property, pseudoElement }
  );
}

async function assertReadableText(params: {
  background: Locator;
  foreground: Locator;
  label: string;
  minimum?: number;
}) {
  const foregroundColor = parseRgb(await computedStyle(params.foreground, "color"));
  const backgroundColor = parseRgb(
    await computedStyle(params.background, "background-color")
  );

  expect(
    contrastRatio(foregroundColor, backgroundColor),
    params.label
  ).toBeGreaterThanOrEqual(params.minimum ?? 4.5);
}

async function assertTangerineFocusRing(locator: Locator, focusTarget = locator) {
  await focusTarget.focus();
  await expect(locator).toHaveCSS("outline-color", "rgb(255, 138, 31)");
  await expect(locator).toHaveCSS("outline-style", "solid");
}

async function openTodoThread(page: Page) {
  await page
    .getByRole("button", { name: /Add AGENTS docs for media VCL/i })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Add AGENTS docs for media VCL",
    })
  ).toBeVisible();
}

test("renders the desktop shell with the black-first Tangerine Terminal theme", async ({}, testInfo) => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      themeSpecDir,
      "fixtures/codex-todo-list/replay.fixture.json"
    ),
    windowSize: {
      height: 920,
      width: 1440,
    },
  });

  try {
    await openTodoThread(app.window);

    await expect(
      app.window.getByRole("heading", { name: "Browse" })
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("heading", { name: "Transcript" })
    ).toHaveCount(0);
    await expect(app.window.getByText(/^\d+ messages?$/)).toHaveCount(0);

    const shell = app.window.locator(".app-shell");
    const sidebar = app.window.locator(".sidebar");
    const transcriptPanel = app.window.locator(".transcript-panel");
    const composer = app.window.locator(".composer");
    const activeLens = app.window.locator(".lens-switch__button.is-active");
    const selectedRow = app.window.locator(".thread-row.is-selected").first();
    const primaryButton = app.window.locator(".button--primary").first();
    const composerInput = app.window.getByLabel("Reply");
    const sendButton = app.window.getByRole("button", { name: "Send" });

    await expect(shell).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(sidebar).toHaveCSS("background-color", "rgb(5, 5, 5)");
    // Issue #240: the transcript and composer panes are both
    // transparent — they ride the app-shell's `--bg-app` background.
    // The textarea / picker buttons inside the composer carry their
    // own bg-input + border styling, which is enough visual
    // differentiation without tinting the whole composer surface.
    await expect(transcriptPanel).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(composer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(activeLens).toHaveCSS("background-color", "rgb(18, 8, 0)");
    await expect(activeLens).toHaveCSS("color", "rgb(255, 179, 92)");
    await expect(primaryButton).toHaveCSS("background-color", "rgb(18, 8, 0)");
    await expect(primaryButton).toHaveCSS("color", "rgb(255, 179, 92)");
    await expect(selectedRow).toHaveCSS("border-left-color", "rgba(255, 138, 31, 0.42)");
    expect(await computedPseudoStyle(selectedRow, "::before", "background-color")).toBe(
      "rgb(255, 138, 31)"
    );
    expect(await computedPseudoStyle(selectedRow, "::before", "width")).toBe("3px");

    await assertReadableText({
      background: sidebar,
      foreground: app.window.locator(".thread-row__title").first(),
      label: "thread row title on sidebar",
    });
    // Issue #240: transcript-panel is transparent now, so its
    // `background-color` reads as `rgba(0, 0, 0, 0)` and would defeat
    // the contrast calculation. The actual visible surface behind
    // transcript text is the app-shell's `--bg-app`. Use that as the
    // readability reference.
    await assertReadableText({
      background: shell,
      foreground: app.window.locator(".transcript-message__text").first(),
      label: "transcript body on app shell",
    });
    // Issue #240: the "Reply" / "New thread" eyebrow was removed
    // from the composer. The input's own `aria-label` and placeholder
    // already convey what the row is for, so there's no longer a
    // text node sitting directly on the composer's bg-panel surface
    // to assert contrast against. The textarea / picker children all
    // carry their own bg-input or button styling.
    await app.window.screenshot({
      path: testInfo.outputPath("tangerine-terminal-wide.png"),
    });

    await assertTangerineFocusRing(activeLens);
    await assertTangerineFocusRing(composerInput);
    await composerInput.fill("Focus ring check");
    await expect(sendButton).toBeEnabled();
    await assertTangerineFocusRing(sendButton);
  } finally {
    await app.close();
  }
});

test("keeps workflow states and narrow desktop layout readable", async ({}, testInfo) => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      themeSpecDir,
      "fixtures/approval-pending/replay.fixture.json"
    ),
    windowSize: {
      height: 760,
      width: 980,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Approval pending replay/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Approval pending replay",
      })
    ).toBeVisible();

    await app.window
      .getByLabel("Reply")
      .fill("Read /etc/hosts and tell me the first three lines.");
    await app.window.getByRole("button", { name: "Send" }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "request-approval-1" });

    const transcriptPanel = app.window.locator(".transcript-panel");
    const contextRail = app.window.locator(".context-rail");
    const composer = app.window.locator(".composer");
    const shell = app.window.locator(".app-shell");
    const approval = app.window.getByRole("group", { name: "Pending approval" });

    await expect(transcriptPanel).toBeVisible();
    await expect(contextRail).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(approval).toContainText("Approval needed");
    await expect(approval).toContainText(
      "Do you want to allow network access so I can query npm metadata for the dive package?"
    );
    await expect(approval.getByText("Command:")).toBeVisible();
    await expect(approval.locator("pre code")).toHaveText("npm view dive");
    await expect(app.window.getByRole("status")).toContainText("Waiting for approval");
    await expect(app.window.locator(".thinking-scanner").first()).toBeVisible();

    // Issue #240: transcript-panel is transparent — read against the
    // app-shell `--bg-app` for the readability calc.
    await assertReadableText({
      background: shell,
      foreground: approval.locator(".transcript-request__prompt"),
      label: "approval prompt on app shell",
    });

    const transcriptBox = await transcriptPanel.boundingBox();
    const composerBox = await composer.boundingBox();
    expect(transcriptBox?.width ?? 0, "narrow transcript width").toBeGreaterThan(320);
    expect(composerBox?.width ?? 0, "narrow composer width").toBeGreaterThan(320);

    await app.window.screenshot({
      path: testInfo.outputPath("tangerine-terminal-narrow-approval.png"),
    });
  } finally {
    await app.close();
  }
});
