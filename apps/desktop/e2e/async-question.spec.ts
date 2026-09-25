import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const asyncQuestionSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function openAsyncQuestionReplay() {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      asyncQuestionSpecDir,
      "fixtures/async-question/replay.fixture.json"
    )
  });

  await app.window
    .getByRole("button", { name: /Gateway endpoint fallback/i })
    .first()
    .click();

  await expect(
    app.window.getByRole("heading", {
      level: 2,
      name: "Gateway endpoint fallback"
    })
  ).toBeVisible();

  return app;
}

test("answers a free-text async question with Codex's structured reply", async () => {
  const app = await openAsyncQuestionReplay();

  try {
    const cards = app.window.getByRole("group", { name: "Question from Codex" });
    await expect(cards).toHaveCount(2);
    const freeText = cards.nth(0);
    const withOptions = cards.nth(1);

    // A question without options asks for text and offers no choice.
    await expect(freeText.getByText("Choose an option")).toHaveCount(0);
    await expect(
      withOptions.getByRole("button", { name: /Try the next endpoint/ })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(withOptions.getByText("Recommended")).toBeVisible();

    await expect(freeText.getByRole("button", { name: "Answer" })).toBeDisabled();
    await freeText
      .getByLabel("Your answer")
      .fill("ws://gateway.example:47830, then wss://edge.example/gateway");
    await freeText.getByRole("button", { name: "Answer" }).click();

    await expect
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({
        threadId: "thread-async-question",
        input: [
          {
            type: "text",
            text: "<send_user_message_question_reply>\n"
              + JSON.stringify([{
                answer: "ws://gateway.example:47830, then wss://edge.example/gateway",
                question: "Which gateway endpoints does the failing profile list, in order?",
                questionItemId: JSON.stringify([
                  "request_user_input_async",
                  "call-endpoints",
                  0,
                ]),
              }])
              + "\n</send_user_message_question_reply>"
          }
        ]
      });

    await expect(freeText.getByText("Answered")).toBeVisible();
    await expect(freeText.getByLabel("Your answer")).toHaveCount(0);
    // The reply renders as the answered question, not as the raw envelope.
    await expect(
      app.window.getByText("<send_user_message_question_reply>")
    ).toHaveCount(0);

    // The other question stays open, and can be dismissed.
    await withOptions.getByRole("button", { name: "Dismiss" }).click();
    await expect(withOptions.getByText("Dismissed")).toBeVisible();
    await expect(
      withOptions.getByRole("button", { name: "Show questions" })
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
