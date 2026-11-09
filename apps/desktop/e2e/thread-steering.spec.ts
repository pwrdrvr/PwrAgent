import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

test("accepts duplicate steering once and retains the active turn until provider completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-steering-e2e-"));
  const fixture = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/turn-lifecycle/replay.fixture.json"), "utf8")) as ReplayFixture;
  fixture.metadata.scenario = "thread-steering";
  const initialize = fixture.steps.find((step) => step.kind === "response" && step.method === "initialize");
  if (initialize?.kind !== "response") throw new Error("Missing initialize fixture");
  (initialize.result as { methods: string[] }).methods.push("turn/steer");
  const started = fixture.steps.find((step) => step.kind === "response" && step.method === "turn/start");
  if (started?.kind !== "response") throw new Error("Missing start fixture");
  const turn = started.result as { threadId: string; turnId: string };
  // This response is single-use. A second provider submission fails the replay.
  const activeIndex = fixture.steps.findIndex((step) => step.id === "turn-started-1");
  if (activeIndex < 0) throw new Error("Missing active-turn fixture");
  fixture.steps.splice(activeIndex + 1, 0, { id: "steer-once", kind: "response", method: "turn/steer", result: turn });
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture));
  const app = await launchElectronApp({ fixturePath });
  try {
    await app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first().click();
    await expect(app.window.getByText("lifecycle baseline ready", { exact: true })).toBeVisible();
    await app.window.getByRole("textbox", { name: "Reply", exact: true }).fill("Start the fixture turn");
    await app.window.getByRole("button", { name: "Send", exact: true }).click();
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    const results = await app.window.evaluate(async (turn) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const request = { backend: "codex" as const, threadId: turn.threadId, expectedTurnId: turn.turnId,
        requestId: "steer-once", input: [{ type: "text" as const, text: "Course correct once" }] };
      return await Promise.all(Array.from({ length: 3 }, () => api.steerTurn!(request)));
    }, turn);
    expect(results).toEqual(Array(3).fill({ backend: "codex", ...turn, disposition: "steered" }));
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    for (const step of fixture.steps.slice(activeIndex + 2)) {
      if (step.kind === "notification") await app.advance({ stepId: step.id });
    }
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
