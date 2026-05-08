import { describe, expect, it, vi } from "vitest";
import type {
  EnsureDirectoryLaunchpadResponse,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
} from "@pwragent/shared";
import { registerDirectoryFromDisk } from "../app-server/directory-registration-service";

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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
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

    expect(result.ok).toBe(false);
    if (result.ok) return;
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

    expect(result.ok).toBe(false);
    if (result.ok) return;
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

    expect(result.ok).toBe(false);
    if (result.ok) return;
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

    expect(result.ok).toBe(false);
    if (result.ok) return;
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.currentBranch).toBeUndefined();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ currentBranch: undefined }),
    );
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
