import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDirectorySummaries, classifyDirectory } from "@pwragent/shared";
import type {
  AppServerBackendKind,
  EnsureDirectoryLaunchpadResponse,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  RegisterDirectoryFromDiskResponse,
} from "@pwragent/shared";
import { registerDirectoryFromDisk } from "../app-server/directory-registration-service";

/**
 * Narrowing helpers that THROW on the wrong branch. The previous
 * `expect(result.ok).toBe(true); if (!result.ok) return;` pattern
 * relies on `expect` running first to fail the test — fine when
 * authored together, but easy to copy-paste without the `expect` and
 * end up with a silent no-op. These helpers make the negative branch
 * fail loudly even on its own, and TypeScript narrows the return value
 * for the rest of the test body.
 */
function assertOk(
  result: RegisterDirectoryFromDiskResponse,
): asserts result is Extract<RegisterDirectoryFromDiskResponse, { ok: true }> {
  if (!result.ok) {
    throw new Error(
      `Expected ok result, got failure: ${result.reason} — ${result.message}`,
    );
  }
}

function assertFailed(
  result: RegisterDirectoryFromDiskResponse,
): asserts result is Extract<RegisterDirectoryFromDiskResponse, { ok: false }> {
  if (result.ok) {
    throw new Error(
      `Expected failure result, got ok: ${result.directoryKey}`,
    );
  }
}

// Tests for the project-directory picker registration path (issue #223).
// We stub the filesystem and `git` invocations so the suite stays fast
// and deterministic — the integration with `git-directory-service` is
// covered by `git-directory-service.test.ts`. Each test asserts on the
// structured pass/fail shape the renderer's `ProjectPicker` consumes.

const sampleLaunchpad: NavigationLaunchpadDraft = {
  directoryKey: "directory:/tmp/sample",
  directoryKind: "directory",
  directoryLabel: "sample",
  directoryPath: "/tmp/sample",
  backend: "codex",
  executionMode: "default",
  prompt: "",
  workMode: "local",
  createdAt: 1,
  updatedAt: 1,
};

const sampleDefaults: NavigationLaunchpadDefaults = {
  backend: "codex",
  executionMode: "default",
};

function buildEnsureSpy() {
  return vi.fn<
    (request: {
      directoryKey: string;
      directoryKind: "directory";
      directoryLabel: string;
      directoryPath: string;
      currentBranch?: string;
      preferredBackend?: AppServerBackendKind;
      registeredAt?: number;
    }) => Promise<EnsureDirectoryLaunchpadResponse>
  >(async (request) => {
    return {
      launchpad: {
        ...sampleLaunchpad,
        directoryKey: request.directoryKey,
        directoryLabel: request.directoryLabel,
        directoryPath: request.directoryPath,
        branchName: request.currentBranch,
        registeredAt: request.registeredAt,
      },
      defaults: sampleDefaults,
    };
  });
}

function statDir(): Promise<{ isDirectory: () => boolean }> {
  return Promise.resolve({ isDirectory: () => true });
}

function statFile(): Promise<{ isDirectory: () => boolean }> {
  return Promise.resolve({ isDirectory: () => false });
}

describe("registerDirectoryFromDisk", () => {
  it("seeds a launchpad and returns canonical metadata for a git repo", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn<
      (cwd: string, args: string[]) => Promise<string>
    >(async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/Users/fixture-user/code/PwrAgent";
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return "main";
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await registerDirectoryFromDisk(
      { path: "/Users/fixture-user/code/PwrAgent" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    assertOk(result);
    expect(result.directoryPath).toBe("/Users/fixture-user/code/PwrAgent");
    expect(result.directoryKey).toBe("directory:/Users/fixture-user/code/PwrAgent");
    expect(result.directoryLabel).toBe("PwrAgent");
    expect(result.currentBranch).toBe("main");
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      directoryKey: "directory:/Users/fixture-user/code/PwrAgent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/code/PwrAgent",
      currentBranch: "main",
      preferredBackend: undefined,
      registeredAt: expect.any(Number),
    });
    expect(result.launchpad.registeredAt).toEqual(expect.any(Number));
  });

  it("normalizes symlinked roots via `git rev-parse --show-toplevel`", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/Users/me/repos/canonical-name";
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return "main";
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await registerDirectoryFromDisk(
      { path: "/Users/me/symlink-to-repo" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    assertOk(result);
    expect(result.directoryPath).toBe("/Users/me/repos/canonical-name");
    expect(result.directoryKey).toBe(
      "directory:/Users/me/repos/canonical-name",
    );
  });

  it.each([
    "/tmp/not-a-repo",
    "C:\\Users\\fixture-user\\notes",
    "/Users/fixture-user/Documents/Codex",
    "/tmp/plain/.worktrees/abc123/notes",
    "C:\\plain\\.worktrees\\abc123\\notes",
  ])("registers the selected non-git folder %s without repo normalization", async (candidate) => {
    const directoryPath = candidate.replace(/\\/g, "/");
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async () => {
      throw new Error("fatal: not a git repository");
    });

    const result = await registerDirectoryFromDisk(
      { path: candidate, preferredBackend: "acp:grok" },
      { ensureDirectoryLaunchpad: ensure, runGit, statPath: statDir },
    );

    assertOk(result);
    expect(result.directoryPath).toBe(directoryPath);
    expect(result.directoryKey).toBe(`directory:${directoryPath}`);
    expect(result.currentBranch).toBeUndefined();
    const directory = {
      id: directoryPath,
      kind: "local" as const,
      path: directoryPath,
      label: result.directoryLabel,
    };
    expect(classifyDirectory(directory).key).toBe(result.directoryKey);
    const summaries = buildDirectorySummaries({
      threads: [{
        id: "plain-folder-thread",
        source: "codex",
        title: "Plain folder",
        titleSource: "explicit",
        linkedDirectories: [directory],
        inbox: { inInbox: false },
      }],
      launchpadsByKey: { [result.directoryKey]: result.launchpad },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      key: result.directoryKey,
      path: directoryPath,
      threadKeys: ["codex:plain-folder-thread"],
    });
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      directoryKey: `directory:${directoryPath}`,
      directoryKind: "directory",
      directoryLabel: path.basename(directoryPath),
      directoryPath,
      currentBranch: undefined,
      preferredBackend: "acp:grok",
      registeredAt: expect.any(Number),
    });
    expect(runGit).toHaveBeenCalledExactlyOnceWith(candidate, [
      "rev-parse", "--show-toplevel",
    ]);
  });

  it("registers a folder when git reports an empty root", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async () => "  ");
    const result = await registerDirectoryFromDisk(
      { path: "/tmp/notes" },
      { ensureDirectoryLaunchpad: ensure, runGit, statPath: statDir },
    );

    assertOk(result);
    expect(result.directoryPath).toBe("/tmp/notes");
    expect(result.currentBranch).toBeUndefined();
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it("registers a real plain folder with the same key as navigation classification", async () => {
    const candidate = await mkdtemp(path.join(os.tmpdir(), "pwragent-plain-directory-"));
    try {
      const result = await registerDirectoryFromDisk(
        { path: candidate },
        { ensureDirectoryLaunchpad: buildEnsureSpy() },
      );
      assertOk(result);
      const classified = classifyDirectory({
        id: candidate, kind: "local", path: candidate, label: path.basename(candidate),
      });
      expect(result.directoryKey).toBe(classified.key);
      expect(result.directoryPath).toBe(candidate.replace(/\\/g, "/"));
      expect(result.currentBranch).toBeUndefined();
      expect(result.launchpad.workMode).toBe("local");
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  });

  it("returns not-a-directory when the chosen path is a file", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async () => "");

    const result = await registerDirectoryFromDisk(
      { path: "/tmp/just-a-file.txt" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statFile,
      },
    );

    assertFailed(result);
    expect(result.reason).toBe("not-a-directory");
    expect(ensure).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("returns inaccessible when stat throws", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async () => "");

    const result = await registerDirectoryFromDisk(
      { path: "/tmp/missing" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: () => Promise.reject(new Error("ENOENT")),
      },
    );

    assertFailed(result);
    expect(result.reason).toBe("inaccessible");
    expect(ensure).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("returns inaccessible when path is empty", async () => {
    const ensure = buildEnsureSpy();
    const result = await registerDirectoryFromDisk(
      { path: "   " },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit: vi.fn(),
        statPath: statDir,
      },
    );

    assertFailed(result);
    expect(result.reason).toBe("inaccessible");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("leaves currentBranch undefined for detached HEAD repos", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/tmp/repo";
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return "HEAD";
      }
      return "";
    });

    const result = await registerDirectoryFromDisk(
      { path: "/tmp/repo" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    assertOk(result);
    expect(result.currentBranch).toBeUndefined();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ currentBranch: undefined }),
    );
  });

  it("canonicalizes pwragent-managed worktree paths back to the parent repo", async () => {
    // When the user picks a directory inside `<repo>/.worktrees/<hash>/<project>`,
    // `git rev-parse --show-toplevel` reports the worktree path. We
    // canonicalize back to `<repo>` so the directoryKey dedupes against
    // the existing canonical-repo entry rather than producing a duplicate
    // "PwrAgent" pinned at the worktree path.
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/Users/me/code/PwrAgent/.worktrees/abc123/PwrAgent";
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return "feat/x";
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await registerDirectoryFromDisk(
      { path: "/Users/me/code/PwrAgent/.worktrees/abc123/PwrAgent" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    assertOk(result);
    expect(result.directoryPath).toBe("/Users/me/code/PwrAgent");
    expect(result.directoryKey).toBe("directory:/Users/me/code/PwrAgent");
    expect(result.directoryLabel).toBe("PwrAgent");
    expect(classifyDirectory({
      id: "/Users/me/code/PwrAgent/.worktrees/abc123/PwrAgent",
      kind: "worktree",
      path: "/Users/me/code/PwrAgent/.worktrees/abc123/PwrAgent",
      label: "PwrAgent",
    }).key).toBe(result.directoryKey);
  });

  it("propagates preferredBackend through to ensureDirectoryLaunchpad", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/tmp/repo";
      }
      return "main";
    });

    await registerDirectoryFromDisk(
      { path: "/tmp/repo", preferredBackend: "acp:grok" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    expect(ensure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ preferredBackend: "acp:grok" }),
    );
  });
});
