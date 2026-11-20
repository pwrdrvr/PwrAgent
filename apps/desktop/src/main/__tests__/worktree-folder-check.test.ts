import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { checkWorktreeFolder } from "../settings/worktree-folder-check";

// Records every synchronous filesystem probe the settings service makes.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    accessSync: vi.fn(actual.accessSync),
    existsSync: vi.fn(actual.existsSync),
    lstatSync: vi.fn(actual.lstatSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-worktree-folder-check-"));
  roots.push(root);
  return root;
}

/**
 * Rules: reading Settings never touches the worktree folder, since a stat on
 * a stale network mount can block the main process; the on-demand check
 * answers within its timeout even when the stat never returns.
 */
describe("worktree folder availability", () => {
  it("builds the settings snapshot without touching the worktree folder", async () => {
    const root = tempRoot();
    const folder = path.join(root, "Volumes", "Stale");
    const configPath = path.join(root, "config.toml");
    writeFileSync(configPath, `[worktrees]\nstorage = "user-home"\nbase_directory = ${JSON.stringify(folder)}\n`);
    const service = new DesktopSettingsService({ configPath, env: {}, secretStore: new MemoryDesktopSecretStore() });
    const probes = [fs.statSync, fs.accessSync, fs.existsSync, fs.lstatSync, fs.readdirSync]
      .map((probe) => vi.mocked(probe as (target: fs.PathLike) => unknown));
    for (const probe of probes) probe.mockClear();

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.worktrees.baseDirectory).toBe(folder);
    const touched = probes.flatMap((probe) => probe.mock.calls.map((call) => String(call[0])))
      .filter((target) => target === folder || target.startsWith(`${folder}${path.sep}`));
    expect(touched).toEqual([]);
  });

  it("answers available, missing, or not responding", async () => {
    const root = tempRoot();
    const file = path.join(root, "file");
    writeFileSync(file, "");
    expect(await checkWorktreeFolder(root)).toBe("available");
    expect(await checkWorktreeFolder(path.join(root, "unplugged"))).toBe("missing");
    expect(await checkWorktreeFolder(file)).toBe("missing");
    const hung = await checkWorktreeFolder(root, {
      timeoutMs: 20,
      statDirectory: () => new Promise(() => {}),
    });
    expect(hung).toBe("not-responding");
  });

  it("joins a stat that is still running instead of starting another", async () => {
    const folder = path.join(tempRoot(), "stale-share");
    const statDirectory = vi.fn(() => new Promise<{ isDirectory(): boolean }>(() => {}));
    const checks = await Promise.all(
      Array.from({ length: 6 }, () => checkWorktreeFolder(folder, { timeoutMs: 10, statDirectory })),
    );
    // A second round, as on the next window focus, while the stat still hangs.
    checks.push(await checkWorktreeFolder(folder, { timeoutMs: 10, statDirectory }));
    expect(checks).toEqual(Array(7).fill("not-responding"));
    expect(statDirectory).toHaveBeenCalledTimes(1);
  });
});
