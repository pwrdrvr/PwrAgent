import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = "/tmp/pwragent-source-link-e2e";
const sourcePath = path.join(sourceRoot, "source.ts");

test("opens transcript source links with VS Code line metadata", async () => {
  const capturePath = path.join(sourceRoot, "application-open.json");
  const fakeBinDir = path.join(sourceRoot, "bin");

  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    sourcePath,
    Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
    "utf8"
  );
  await writeFile(path.join(fakeBinDir, "code"), "#!/bin/sh\nexit 0\n", {
    encoding: "utf8",
    mode: 0o755,
  });

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/source-link-editor-open/replay.fixture.json"
    ),
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      PWRAGENT_E2E_APPLICATION_OPEN_CAPTURE_PATH: capturePath,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Source link editor open/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Source link editor open",
      })
    ).toBeVisible();
    await expect
      .poll(async () =>
        await app.window.evaluate(async () => {
          const api = (
            window as Window & {
              pwragent?: {
                readSettings?: (
                  request: Record<string, never>
                ) => Promise<{
                  snapshot: { applications: { editors: Array<{ id: string }> } };
                }>;
              };
            }
          ).pwragent;
          const settings = await api?.readSettings?.({});
          return settings?.snapshot.applications.editors.map((editor) => editor.id) ?? [];
        })
      )
      .toContain("vscode");

    const reviewCard = app.window.getByRole("group", { name: "Code review" }).last();
    await expect(reviewCard).toContainText("Open this source link");
    await expect(reviewCard).toContainText("Line 12");

    await reviewCard.locator("a.transcript-review__location-path").click();

    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(capturePath, "utf8"));
        } catch {
          return null;
        }
      })
      .toMatchObject({
        request: {
          applicationId: "vscode",
          kind: "editor",
          targetPath: sourcePath,
          targetLine: 12,
        },
        invocation: {
          args: ["--goto", `${sourcePath}:12`],
        },
      });
  } finally {
    await app.close();
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
