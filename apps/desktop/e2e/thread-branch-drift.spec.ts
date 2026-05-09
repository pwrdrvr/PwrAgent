import { expect, test } from "@playwright/test";
import { createBranchDriftFixture, readThreadPayload } from "./fixtures/branch-drift-fixture";
import { launchElectronApp } from "./fixtures/electron-app";

test("keeps the branch drift warning open after refreshing observed checkout state", async () => {
  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      HOME: fixture.homeDir,
    },
  });

  try {
    const dialog = app.window.getByRole("dialog", {
      name: "Thread branch changed",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("codex/expected-branch");
    await expect(dialog).toContainText("codex/current-branch");
    await expect(dialog).toContainText("I'll switch back");
    await expect(dialog).toContainText("Keep current branch");
    await expect(
      app.window.getByRole("button", {
        name: "Keep warning. I'll switch back to codex/expected-branch",
      }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("button", {
        name: "Accept current branch as correct. Continue working on codex/current-branch without further warnings",
      }),
    ).toBeVisible();
    const actionHeights = await dialog
      .locator(".workspace-handoff-dialog__action")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().height),
      );
    expect(actionHeights).toHaveLength(2);
    expect(Math.abs(actionHeights[0] - actionHeights[1])).toBeLessThanOrEqual(
      1,
    );

    await app.window.waitForTimeout(7_000);

    await expect(dialog).toBeVisible();

    expect(readThreadPayload(fixture.homeDir)).toMatchObject({
      gitBranch: "codex/expected-branch",
      observedGitBranch: "codex/current-branch",
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("keeps the branch drift indicator when the user keeps the warning", async () => {
  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      HOME: fixture.homeDir,
    },
  });

  try {
    await app.window
      .getByRole("button", {
        name: "Keep warning. I'll switch back to codex/expected-branch",
      })
      .click();

    await expect(
      app.window.getByRole("dialog", { name: "Thread branch changed" }),
    ).toBeHidden();
    await expect(app.window.getByText(/Branch warning:/)).toBeVisible();
    expect(readThreadPayload(fixture.homeDir)).toMatchObject({
      gitBranch: "codex/expected-branch",
      observedGitBranch: "codex/current-branch",
      retainedBranchDriftPairs: [
        {
          expectedBranch: "codex/expected-branch",
          observedBranch: "codex/current-branch",
        },
      ],
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("updates the expected branch when the user accepts the current branch", async () => {
  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      HOME: fixture.homeDir,
    },
  });

  try {
    await app.window
      .getByRole("button", {
        name: "Accept current branch as correct. Continue working on codex/current-branch without further warnings",
      })
      .click();

    await expect(
      app.window.getByRole("dialog", { name: "Thread branch changed" }),
    ).toBeHidden();
    expect(readThreadPayload(fixture.homeDir)).toMatchObject({
      gitBranch: "codex/current-branch",
      observedGitBranch: "codex/current-branch",
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
