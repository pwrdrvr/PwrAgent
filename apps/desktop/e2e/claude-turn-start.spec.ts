import path from "node:path";
import os from "node:os";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("keeps an accepted Claude start active through best-effort origin storage refusal and completes later turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-owner-e2e-"));
  const bin = path.join(root, "bin");
  const cliDir = path.join(bin, "node_modules/@anthropic-ai/claude-code");
  await mkdir(cliDir, { recursive: true });
  const cli = path.join(cliDir, "cli.js");
  await copyFile(path.join(specDir, "../src/main/__tests__/fixtures/claude-owner-cli.cjs"), cli);
  await chmod(cli, 0o755);
  if (process.platform !== "win32") await symlink(cli, path.join(bin, "claude"));
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/turn-lifecycle/replay.fixture.json"),
    env: { PATH: [bin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      CLAUDE_CONFIG_DIR: path.join(root, "claude-config") },
  });
  const output: string[] = [];
  const collect = (chunk: Buffer) => { output.push(chunk.toString()); };
  app.electronApp.process().stdout?.on("data", collect);
  app.electronApp.process().stderr?.on("data", collect);
  const db = new Database(stateDbPathForHomeRoot(app.homeRoot));
  try {
    const threadId = await app.window.evaluate(async (cwd) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const thread = await api.startThread!({ backend: "claude", cwd, executionMode: "auto" });
      await api.renameThread!({ backend: "claude", threadId: thread.threadId, name: "Claude owner fixture" });
      return thread.threadId;
    }, root);
    await app.window.getByRole("button", { name: /Claude owner fixture/ }).first().click();
    // The concrete origin helper already handles ordinary I/O best effort.
    // The real-owner oracle separately injects a rejecting finalization port.
    db.exec(`CREATE TRIGGER refuse_claude_origin BEFORE INSERT ON thread_message_origins
      WHEN NEW.backend = 'claude'
      BEGIN SELECT RAISE(ABORT, 'Fixture Claude origin storage refused'); END`);
    for (let index = 1; index <= 2; index += 1) {
      const accepted = await app.window.evaluate(async ({ threadId, index }) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        // Exercise the trusted owner's origin port through the normal IPC
        // handler; the renderer's narrower request type does not expose it.
        const request = { backend: "claude" as const, threadId,
          input: [{ type: "text" as const, text: `Claude fixture ${index}` }], messageOrigin: { kind: "messaging" as const } };
        return await api.startTurn!(request);
      }, { threadId, index });
      expect(accepted).toMatchObject({ backend: "claude", threadId, turnId: expect.any(String) });
      expect(accepted).toHaveProperty("queueStatus", "started");
      await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
      await expect.poll(async () => {
        const requests = await readFile(path.join(cliDir, "claude-requests.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        return requests.trim() ? requests.trim().split("\n").length : 0;
      }).toBe(index);
      await writeFile(path.join(cliDir, `release-${index}`), "");
      await expect(app.window.getByRole("region", { name: "Transcript" }).getByText(
        `Claude fixture completed ${index}.`, { exact: true })).toBeVisible();
      await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
    }
    await expect.poll(() => output.join("")).toContain("Fixture Claude origin storage refused");
    expect(output.join("")).toContain("failed to persist injected message origin");
  } finally {
    db.close();
    await Promise.all([1, 2].map((index) => writeFile(path.join(cliDir, `release-${index}`), "")));
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
