import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const todoListSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function openThreadByTitle(
  fixturePath: string,
  threadTitle: string
) {
  const app = await launchElectronApp({ fixturePath });

  await app.window.getByRole("button", { name: new RegExp(threadTitle, "i") }).first().click();
  await expect(
    app.window.getByRole("heading", {
      level: 2,
      name: threadTitle
    })
  ).toBeVisible();

  return app;
}

test("renders a persisted Codex task plan when the thread is selected", async () => {
  const app = await openThreadByTitle(
    path.resolve(
      todoListSpecDir,
      "fixtures/codex-todo-list/replay.fixture.json"
    ),
    "Add AGENTS docs for media VCL"
  );

  try {
    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const plan = transcript.getByRole("group", { name: "Task plan" });

    await expect(plan).toBeVisible();
    await expect(plan).toContainText("0 out of 3 tasks completed");
    await expect(plan).toContainText(
      "Start the implementation by creating a local root plan file named `IMPLEMENTATION_PLAN.local.md` and add that exact filename to `.gitignore`."
    );
    await expect(plan).toContainText(
      "The local plan file should begin with a short facts/goals section, followed by a `To-Do` section using Markdown checkboxes that get updated as work is completed."
    );
    await expect(plan).toContainText(
      "Establish the repo pattern for scoped context, but implement it fully only for `gif-media` in this pass."
    );
    await expect(plan.getByText("Pending", { exact: true })).toHaveCount(3);
  } finally {
    await app.close();
  }
});

test("renders the Grok task plan contract with mixed step states", async () => {
  const app = await openThreadByTitle(
    path.resolve(
      todoListSpecDir,
      "fixtures/grok-todo-list/replay.fixture.json"
    ),
    "Grok to-do list replay"
  );

  try {
    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const plan = transcript.getByRole("group", { name: "Task plan" });

    await expect(plan).toBeVisible();
    await expect(plan).toContainText("1 out of 3 tasks completed");
    await expect(plan).toContainText(
      "Checking the shared contract and renderer before summarizing the dependency."
    );
    await expect(plan).toContainText("Inspect contract type");
    await expect(plan).toContainText("Inspect renderer usage");
    await expect(plan).toContainText("Summarize dependency");
    await expect(plan.getByText("Completed", { exact: true })).toBeVisible();
    await expect(plan.getByText("In progress", { exact: true })).toBeVisible();
    await expect(plan.getByText("Pending", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("renders live plan updates from turn/plan/updated notifications", async () => {
  const app = await openThreadByTitle(
    path.resolve(
      todoListSpecDir,
      "fixtures/live-plan-updates/replay.fixture.json"
    ),
    "Live plan updates replay"
  );

  try {
    await app.window
      .getByLabel("Reply")
      .fill("Create a three-step task list before you inspect the renderer.");
    await app.window.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const planGroups = transcript.getByRole("group", { name: "Task plan" });

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "plan-updated-1" });

    await expect(planGroups).toHaveCount(1);
    await expect(planGroups.first()).toContainText("1 out of 3 tasks completed");
    await expect(planGroups.first()).toContainText(
      "Check the shared contract and transcript renderer before summarizing the dependency."
    );
    await expect(planGroups.first()).toContainText("Inspect AppServerThreadPlanEntry");
    await expect(planGroups.first()).toContainText("Inspect TranscriptPlan rendering");
    await expect(planGroups.first()).toContainText("Summarize renderer dependency");

  } finally {
    await app.close();
  }
});
