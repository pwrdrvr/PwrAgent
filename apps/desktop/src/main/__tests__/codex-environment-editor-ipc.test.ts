import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock("../app-server/navigation-directory-index", () => ({
  readLocalNavigationDirectoryIndex: vi.fn(async () => []),
}));

import { assertEditableEnvironmentProject } from "../ipc/codex-environment-editor-ipc";

describe("environment editor project guard", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-guard-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a Git checkout, such as a thread's worktree", async () => {
    await mkdir(path.join(root, ".git"));
    await expect(assertEditableEnvironmentProject(root)).resolves.toBe(root);
  });

  it("accepts a listed project without Git", async () => {
    await expect(assertEditableEnvironmentProject(root, async () => [{ path: root, label: "demo" }]))
      .resolves.toBe(root);
  });

  it("refuses other folders and relative paths", async () => {
    await expect(assertEditableEnvironmentProject(root)).rejects.toThrow(/not a project/);
    await expect(assertEditableEnvironmentProject("relative/path")).rejects.toThrow(/project folder/);
    await expect(assertEditableEnvironmentProject(path.join(root, "missing"))).rejects.toThrow(/project folder/);
  });
});
