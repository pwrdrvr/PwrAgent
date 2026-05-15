import { beforeEach, describe, expect, it, vi } from "vitest";

describe("createThreadDirectoryEnricher", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves the home repo, preserves the worktree path, and caches repeated lookups", async () => {
    const projectPath = "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/feature-one/apps";
    const dotGitPath = "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/feature-one/.git";
    const accessMock = vi.fn(async (targetPath: string) => {
      if (targetPath === projectPath || targetPath === dotGitPath) {
        return undefined;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const readFileMock = vi.fn(async () =>
      "gitdir: /Users/huntharo/pwrdrvr/PwrAgent/.git/worktrees/feature-one\n"
    );
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
      readFile: readFileMock,
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

    const first = await enricher(projectPath);
    const second = await enricher(projectPath);

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
    expect(accessMock).toHaveBeenCalledTimes(3);
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("recovers the home repo from a worktree .git file when git worktree list fails", async () => {
    const projectPath = "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75tdnu/PwrAgnt/apps/desktop";
    const worktreePath = "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75tdnu/PwrAgnt";
    const dotGitPath = `${worktreePath}/.git`;
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async (targetPath: string) => {
        if (targetPath === projectPath || targetPath === dotGitPath) {
          return undefined;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      readFile: vi.fn(async () =>
        "gitdir: /Users/huntharo/pwrdrvr/PwrAgnt/.git/worktrees/PwrAgnt\n"
      ),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
        ) => {
          if (args.includes("--porcelain")) {
            callback(new Error("worktree list failed"));
            return;
          }
          callback(null, {
            stdout: "/Users/huntharo/.codex/profiles/sstk/worktrees/mp75tdnu/PwrAgnt\n",
            stderr: "",
          });
        },
      ),
    }));

    const { createThreadDirectoryEnricher } = await import(
      "../app-server/thread-directory-enricher"
    );
    const enricher = createThreadDirectoryEnricher();

    await expect(enricher(projectPath)).resolves.toEqual({
      linkedDirectories: [
        {
          id: "/Users/huntharo/pwrdrvr/PwrAgnt",
          path: "/Users/huntharo/pwrdrvr/PwrAgnt",
          worktreePath,
          label: "PwrAgnt",
          kind: "worktree",
        },
      ],
    });
  });

  it("returns no linked directories when the anchored path no longer exists", async () => {
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      readFile: vi.fn(),
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
