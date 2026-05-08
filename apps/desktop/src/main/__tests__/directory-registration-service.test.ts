import { describe, expect, it, vi } from "vitest";
import type {
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
    }) => Promise<EnsureDirectoryLaunchpadResponse>
  >(async (request) => {
    return {
      launchpad: {
        ...sampleLaunchpad,
        directoryKey: request.directoryKey,
        directoryLabel: request.directoryLabel,
        directoryPath: request.directoryPath,
        branchName: request.currentBranch,
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
        return "/Users/huntharo/code/PwrAgent";
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return "main";
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await registerDirectoryFromDisk(
      { path: "/Users/huntharo/code/PwrAgent" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    assertOk(result);
    expect(result.directoryPath).toBe("/Users/huntharo/code/PwrAgent");
    expect(result.directoryKey).toBe("directory:/Users/huntharo/code/PwrAgent");
    expect(result.directoryLabel).toBe("PwrAgent");
    expect(result.currentBranch).toBe("main");
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      directoryKey: "directory:/Users/huntharo/code/PwrAgent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/huntharo/code/PwrAgent",
      currentBranch: "main",
      preferredBackend: undefined,
    });
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

  it("returns not-a-git-repo when `git rev-parse` fails", async () => {
    const ensure = buildEnsureSpy();
    const runGit = vi.fn(async () => {
      throw new Error("fatal: not a git repository");
    });

    const result = await registerDirectoryFromDisk(
      { path: "/tmp/not-a-repo" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    assertFailed(result);
    expect(result.reason).toBe("not-a-git-repo");
    expect(result.message).toContain("/tmp/not-a-repo");
    expect(ensure).not.toHaveBeenCalled();
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
      { path: "/tmp/repo", preferredBackend: "grok" },
      {
        ensureDirectoryLaunchpad: ensure,
        runGit,
        statPath: statDir,
      },
    );

    expect(ensure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ preferredBackend: "grok" }),
    );
  });
});
