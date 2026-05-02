import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  specDir,
  "fixtures/skill-autocomplete-interactions/replay.fixture.json",
);
const customWidgetComposerEnv = {
  PWRAGNT_EXPERIMENTAL_CHAT_REPLY_COMPOSER: "custom-widget-chips",
};
const reportedDraftPrefix =
  "Oh shoot... I was wrong about this I think. I thought the desktop app didn't show the tool use but I was looking at a version of the desktop app that didn't start the turn. I just now looked at the instance that started the turn and it does indeed have the tool use notifications.\n\n\n\nLet's use ";

async function openSkillAutocompleteThread(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
) {
  await app.window
    .getByRole("button", { name: /Skill autocomplete replay/i })
    .first()
    .click();
  await expect(
    app.window.getByRole("heading", {
      level: 2,
      name: "Skill autocomplete replay",
    }),
  ).toBeVisible();
  await expect(
    app.window.getByText("Ready to exercise the thread reply composer."),
  ).toBeVisible();
}

async function getActiveOptionIndex(
  listbox: Locator,
): Promise<number> {
  return await listbox.getByRole("button").evaluateAll((buttons) =>
    buttons.findIndex((button) => button.getAttribute("aria-selected") === "true"),
  );
}

async function seedComposerDraft(input: Locator, value: string): Promise<void> {
  await input.evaluate((element, nextValue) => {
    const editor = element as HTMLElement & {
      setSelectionRange: (start: number, end: number) => void;
      value: string;
    };
    editor.value = nextValue;
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    editor.setSelectionRange(nextValue.length, nextValue.length);
  }, value);
  await input.focus();
}

test("thread reply skill autocomplete filters and commits the reported multi-line draft", async () => {
  const app = await launchElectronApp({
    env: customWidgetComposerEnv,
    fixturePath,
    windowSize: {
      width: 1180,
      height: 760,
    },
  });

  try {
    await openSkillAutocompleteThread(app);

    const richInput = app.window.getByTestId("composer-rich-input");
    await seedComposerDraft(richInput, reportedDraftPrefix);
    await app.window.keyboard.type("$ce");
    await expect(app.window.getByRole("listbox", { name: "Skills" })).toBeVisible();

    await app.window.keyboard.type(":p");
    let firstOption = app.window
      .getByRole("listbox", { name: "Skills" })
      .getByRole("button")
      .first();
    await expect(firstOption).toContainText("$ce:plan");

    await app.window.keyboard.type("lan");
    firstOption = app.window
      .getByRole("listbox", { name: "Skills" })
      .getByRole("button")
      .first();
    await expect(firstOption).toContainText("$ce:plan");

    await app.window.keyboard.press("Enter");

    await expect(app.window.getByRole("listbox", { name: "Skills" })).toBeHidden();
    await expect(
      richInput.locator(".skill-chip", { hasText: "$ce:plan" }),
    ).toBeVisible();
    await expect(richInput).toHaveAttribute("data-value", reportedDraftPrefix);
    await expect(richInput).not.toContainText("$ce:plan plan");

    await app.window.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({
        threadId: "thread-skill-autocomplete",
        input: [
          {
            type: "text",
            text: `${reportedDraftPrefix}[$ce:plan](/Users/huntharo/.codex/skills/ce-plan/SKILL.md)`.trim(),
          },
        ],
      });
  } finally {
    await app.close();
  }
});

test("thread reply skill autocomplete has a visible overlay boundary and page navigation", async () => {
  const app = await launchElectronApp({
    env: customWidgetComposerEnv,
    fixturePath,
    windowSize: {
      width: 1180,
      height: 760,
    },
  });

  try {
    await openSkillAutocompleteThread(app);

    const richInput = app.window.getByTestId("composer-rich-input");
    await richInput.focus();
    await app.window.keyboard.type("$");

    const listbox = app.window.getByRole("listbox", { name: "Skills" });
    await expect(listbox).toBeVisible();

    const overlayStyles = await listbox.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: styles.backgroundColor,
        borderTopColor: styles.borderTopColor,
        boxShadow: styles.boxShadow,
      };
    });
    const inputStyles = await richInput.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: styles.backgroundColor,
        borderTopColor: styles.borderTopColor,
      };
    });
    expect(overlayStyles.backgroundColor).not.toBe(inputStyles.backgroundColor);
    expect(overlayStyles.borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(overlayStyles.boxShadow).toContain("inset");

    expect(await getActiveOptionIndex(listbox)).toBe(0);
    await app.window.keyboard.press("PageDown");
    expect(await getActiveOptionIndex(listbox)).toBeGreaterThan(1);
    await app.window.keyboard.press("PageUp");
    expect(await getActiveOptionIndex(listbox)).toBe(0);
  } finally {
    await app.close();
  }
});
