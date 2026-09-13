import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
// `/tmp` is a real directory only on POSIX; on Windows it resolves against the
// current drive and is not where temporary files belong.
const sourceRoot = path.join(os.tmpdir(), "pwragent-source-link-e2e");
const sourcePath = path.join(sourceRoot, "source.ts");
const isWindows = process.platform === "win32";

/** The env var's real spelling is usually `Path` on Windows, and Windows
 *  compares environment names case-insensitively — so write back whichever
 *  spelling this process already carries rather than adding a second key. */
function envKey(name: string): string {
  return (
    Object.keys(process.env).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    ) ?? name
  );
}

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
  // A shebang is not executable on Windows; a `.cmd` that exits 0 is the
  // equivalent stub, and PATHEXT is what makes discovery find it by bare name.
  if (isWindows) {
    await writeFile(path.join(fakeBinDir, "code.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
  } else {
    await writeFile(path.join(fakeBinDir, "code"), "#!/bin/sh\nexit 0\n", {
      encoding: "utf8",
      mode: 0o755,
    });
  }

  const pathKey = envKey("PATH");
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/source-link-editor-open/replay.fixture.json"
    ),
    env: {
      [pathKey]: `${fakeBinDir}${path.delimiter}${process.env[pathKey] ?? ""}`,
      ...(isWindows ? { [envKey("PATHEXT")]: ".COM;.EXE;.BAT;.CMD" } : {}),
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
