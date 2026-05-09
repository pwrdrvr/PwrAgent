import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  specDir,
  "fixtures/skill-autocomplete-interactions/replay.fixture.json",
);
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

test("thread reply Tiptap skill autocomplete filters and commits the reported multi-line draft", async () => {
  const app = await launchElectronApp({
    fixturePath,
    windowSize: {
      width: 1180,
      height: 760,
    },
  });

  try {
    await openSkillAutocompleteThread(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.fill(reportedDraftPrefix);
    await textbox.focus();
    await app.window.keyboard.press("End");
    const seededDraft = await tiptapInput.getAttribute("data-value");
    expect(seededDraft).toMatch(/Let's use $/);

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
      tiptapInput.locator(".composer-tiptap-input__mention", { hasText: "$ce:plan" }),
    ).toBeVisible();
    await expect(tiptapInput).toHaveAttribute("data-value", seededDraft ?? "");
    await expect(tiptapInput).not.toContainText("$ce:plan plan");

    await app.window.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({
        threadId: "thread-skill-autocomplete",
        input: [
          {
            type: "text",
            text: `${seededDraft ?? ""}[$ce:plan](/Users/huntharo/.codex/skills/ce-plan/SKILL.md)`.trim(),
          },
        ],
      });
  } finally {
    await app.close();
  }
});

test("thread reply Tiptap slash review autocomplete stays open on exact command text", async () => {
  const app = await launchElectronApp({
    fixturePath,
    windowSize: {
      width: 1180,
      height: 760,
    },
  });

  try {
    await openSkillAutocompleteThread(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.focus();
    await app.window.keyboard.type("/revie");
    await expect(tiptapInput).toHaveAttribute("data-value", "/revie");
    await expect(app.window.getByRole("listbox", { name: "Commands" })).toBeVisible();

    await app.window.keyboard.type("w");
    await expect(tiptapInput).toHaveAttribute("data-value", "/review");

    const commands = app.window.getByRole("listbox", { name: "Commands" });
    await expect(commands).toBeVisible();
    await expect(commands.getByRole("button", { name: /\/review/i })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("thread reply Tiptap skill insertion preserves rich Markdown blocks", async () => {
  const app = await launchElectronApp({
    fixturePath,
    windowSize: {
      width: 1180,
      height: 760,
    },
  });

  try {
    await openSkillAutocompleteThread(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.focus();
    await textbox.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(
        "text/html",
        [
          "<p>Here is the code:</p>",
          '<pre><code class="language-ts">const value = 1;\nreturn value;</code></pre>',
          "<p>Let's use </p>",
        ].join(""),
      );
      dataTransfer.setData(
        "text/plain",
        "Here is the code:\n\n```ts\nconst value = 1;\nreturn value;\n```\n\nLet's use ",
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });
    const closingParagraph = tiptapInput.locator("p", { hasText: "Let's use" }).last();
    await closingParagraph.click();
    await app.window.keyboard.press("End");
    await app.window.keyboard.type(" ");

    const codeBlock = tiptapInput.locator("pre", {
      hasText: "const value = 1;\nreturn value;",
    });
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).not.toContainText("```");
    const seededDraft = await tiptapInput.getAttribute("data-value");
    expect(seededDraft).toContain("```ts\nconst value = 1;\nreturn value;\n```");
    expect(seededDraft).toMatch(/Let's use $/);

    await app.window.keyboard.type("$ce:plan");
    await expect(
      app.window.getByRole("button", { name: /\$ce:plan/i }),
    ).toBeVisible();
    await app.window.keyboard.press("Enter");

    await expect(
      tiptapInput.locator(".composer-tiptap-input__mention", { hasText: "$ce:plan" }),
    ).toBeVisible();
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).not.toContainText("```");
    await expect(tiptapInput).toHaveAttribute("data-value", seededDraft ?? "");
  } finally {
    await app.close();
  }
});

test("thread reply Tiptap Tab insertion keeps caret after chip and copy-paste preserves skill metadata", async () => {
  const app = await launchElectronApp({
    fixturePath,
    windowSize: {
      width: 1180,
      height: 760,
    },
  });

  try {
    await openSkillAutocompleteThread(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.focus();
    await app.window.keyboard.type("Let's use $ce:plan");
    await expect(
      app.window.getByRole("button", { name: /\$ce:plan/i }),
    ).toBeVisible();
    await app.window.keyboard.press("Tab");

    const caretIsAfterChip = await tiptapInput.evaluate((element) => {
      const chip = element.querySelector(".composer-tiptap-input__mention");
      const selection = window.getSelection();
      if (!chip || !selection || selection.rangeCount === 0) {
        return false;
      }

      const caretRange = selection.getRangeAt(0);
      const afterChipRange = document.createRange();
      afterChipRange.setStartAfter(chip);
      afterChipRange.collapse(true);
      return caretRange.compareBoundaryPoints(
        Range.START_TO_START,
        afterChipRange,
      ) >= 0;
    });
    expect(caretIsAfterChip).toBe(true);

    await app.window.keyboard.type(" after");

    const textAfterTabInsertion = await tiptapInput.innerText();
    expect(textAfterTabInsertion.indexOf("$ce:plan")).toBeGreaterThanOrEqual(0);
    expect(textAfterTabInsertion.indexOf("$ce:plan")).toBeLessThan(
      textAfterTabInsertion.indexOf(" after"),
    );

    const chip = tiptapInput.locator(".composer-tiptap-input__mention", {
      hasText: "$ce:plan",
    });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute(
      "data-skill-path",
      "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
    );

    await textbox.focus();
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+C" : "Control+C",
    );
    await app.window.keyboard.press("Delete");
    await expect(tiptapInput).toHaveAttribute("data-value", "");
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+V" : "Control+V",
    );

    const pastedChip = tiptapInput.locator(".composer-tiptap-input__mention", {
      hasText: "$ce:plan",
    });
    await expect(pastedChip).toBeVisible();
    await expect(tiptapInput.locator(".composer-tiptap-input__mention", {
      hasText: "$skill",
    })).toHaveCount(0);
    await expect(pastedChip).toHaveAttribute(
      "data-skill-path",
      "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
    );
  } finally {
    await app.close();
  }
});
