import { beforeEach, describe, expect, it, vi } from "vitest";

describe("createThreadDirectoryEnricher", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves the home repo, preserves the worktree path, and caches repeated lookups", async () => {
    const accessMock = vi.fn(async () => undefined);
    const execFileMock = vi.fn(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        if (args.includes("--show-toplevel")) {
          callback(null, {
            stdout: "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/feature-one\n",
            stderr: "",
          });
          return;
        }
        if (args.includes("--porcelain")) {
          callback(null, {
            stdout: [
              "worktree /Users/huntharo/pwrdrvr/PwrAgent",
              "worktree /Users/huntharo/pwrdrvr/PwrAgent/.worktrees/feature-one",
            ].join("\n"),
            stderr: "",
          });
          return;
        }
        if (args.includes("--abbrev-ref")) {
          callback(null, {
            stdout: "feature-one\n",
            stderr: "",
          });
          return;
        }

        callback(new Error(`Unexpected git invocation: ${args.join(" ")}`));
      },
    );

    vi.doMock("node:fs/promises", () => ({
      access: accessMock,
    }));
    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { createThreadDirectoryEnricher } = await import(
      "../app-server/thread-directory-enricher"
    );
    const enricher = createThreadDirectoryEnricher({
      cacheTtlMs: 60_000,
    });

    const first = await enricher("/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/feature-one/apps");
    const second = await enricher("/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/feature-one/apps");

    expect(first).toEqual({
      linkedDirectories: [
        {
          id: "/Users/huntharo/pwrdrvr/PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          worktreePath: "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/feature-one",
          label: "PwrAgent",
          kind: "worktree",
        },
      ],
      observedGitBranch: "feature-one",
    });
    expect(second).toEqual(first);
    expect(accessMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("returns no linked directories when the anchored path no longer exists", async () => {
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
    }));

    const { createThreadDirectoryEnricher } = await import(
      "../app-server/thread-directory-enricher"
    );
    const enricher = createThreadDirectoryEnricher();

    await expect(
      enricher("/Users/huntharo/.codex/worktrees/missing/PwrAgent"),
    ).resolves.toEqual({
      linkedDirectories: [],
    });
  });
});
