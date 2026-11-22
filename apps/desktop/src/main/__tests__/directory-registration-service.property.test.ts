import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import type { DirectoryRegistrationDeps } from "../app-server/directory-registration-service";
import { registerDirectoryFromDisk, resolveDirectoryRegistrationRoot } from "../app-server/directory-registration-service";
import { runGitCommand } from "../app-server/git-executable";

vi.mock("node:fs/promises", { spy: true });

function mockLaunchpad() {
  return vi.fn<DirectoryRegistrationDeps["ensureDirectoryLaunchpad"]>(async (request) => ({
    launchpad: { ...request, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1 },
    defaults: { backend: "codex", executionMode: "default" },
  }));
}

describe("Windows project registration", () => {
  const plainFolder = {
    statPath: async () => ({ isDirectory: () => true }),
    runGit: async () => { throw new Error("Not a Git repository"); },
  };

  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    vi.mocked(realpath).mockReset();
    vi.restoreAllMocks();
  });

  it("uses one directory key for every case spelling of a Windows project folder", async () => {
    const parts = fc.array(fc.stringMatching(/^[A-Z][a-z]{1,8}$/), { minLength: 1, maxLength: 4 });
    const paths = parts.chain((segments) => {
      const diskPath = `C:/${segments.join("/")}`;
      const spelling = fc.tuple(...Array.from(diskPath, (character) =>
        fc.constantFrom(character.toLowerCase(), character.toUpperCase()),
      )).map((characters) => characters.join(""));
      return fc.tuple(fc.constant(diskPath), spelling, spelling);
    });
    await fc.assert(fc.asyncProperty(paths, fc.boolean(), async ([diskPath, first, second], gitRepo) => {
      vi.mocked(realpath).mockImplementation(async (target) => {
        expect(String(target).toLowerCase().replace(/\\/g, "/")).toBe(diskPath.toLowerCase());
        return diskPath.replace(/\//g, "\\");
      });
      const deps = {
        ensureDirectoryLaunchpad: mockLaunchpad(),
        statPath: plainFolder.statPath,
        runGit: async (cwd: string, args: string[]) => {
          if (!gitRepo) throw new Error("Not a Git repository");
          if (args.includes("--show-toplevel")) return cwd;
          if (args.includes("--porcelain")) return `worktree ${diskPath}\0\0`;
          return "main";
        },
      };
      const discovery = await resolveDirectoryRegistrationRoot(first, deps);
      const registrations = await Promise.all(
        [diskPath, second].map((path) => registerDirectoryFromDisk({ path }, deps)),
      );
      expect(deps.ensureDirectoryLaunchpad.mock.calls.map(([request]) => request.directoryKey))
        .toEqual([`directory:${diskPath}`, `directory:${diskPath}`]);
      for (const registration of registrations) {
        expect(registration).toMatchObject({
          ok: true, directoryPath: diskPath, directoryKey: `directory:${diskPath}`,
        });
      }
      expect(discovery).toMatchObject({ ok: true, directoryPath: diskPath });
      expect(discovery).not.toHaveProperty("checkoutPath");
    }));
  });

  it("registers c:/aa under the disk's C:/Aa spelling", async () => {
    vi.mocked(realpath).mockResolvedValue("C:\\Aa");
    const ensureDirectoryLaunchpad = mockLaunchpad();
    await expect(registerDirectoryFromDisk({ path: "c:/aa" }, { ...plainFolder, ensureDirectoryLaunchpad }))
      .resolves.toMatchObject({ ok: true, directoryPath: "C:/Aa", directoryKey: "directory:C:/Aa" });
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      directoryPath: "C:/Aa", directoryKey: "directory:C:/Aa",
    }));
  });

  it("reuses an existing key when the old spelling resolves to the same folder", async () => {
    vi.mocked(realpath).mockResolvedValue("C:\\Aa");
    const ensureDirectoryLaunchpad = mockLaunchpad();
    const listDirectoryLaunchpads = async () => [{ directoryKey: "directory:c:/aa" }];
    await expect(registerDirectoryFromDisk({ path: "C:/Aa" }, {
      ...plainFolder, ensureDirectoryLaunchpad, listDirectoryLaunchpads,
    })).resolves.toMatchObject({ ok: true, directoryPath: "C:/Aa", directoryKey: "directory:c:/aa" });
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      directoryPath: "C:/Aa", directoryKey: "directory:c:/aa",
    }));
  });

  it("keeps separate keys when differently cased names resolve to distinct folders", async () => {
    vi.mocked(realpath).mockImplementation(async (target) => String(target));
    const listDirectoryLaunchpads = async () => [{ directoryKey: "directory:C:/aa" }];
    await expect(registerDirectoryFromDisk({ path: "C:/Aa" }, {
      ...plainFolder, ensureDirectoryLaunchpad: mockLaunchpad(), listDirectoryLaunchpads,
    })).resolves.toMatchObject({ ok: true, directoryPath: "C:/Aa", directoryKey: "directory:C:/Aa" });
  });

  it("keeps the selected path when realpath returns a mapped drive's target or fails", async () => {
    vi.mocked(realpath).mockResolvedValueOnce("\\\\server\\share\\app").mockRejectedValueOnce(new Error("ENOENT"));
    await expect(resolveDirectoryRegistrationRoot("Z:\\app", plainFolder))
      .resolves.toEqual({ ok: true, directoryPath: "Z:/app" });
    await expect(resolveDirectoryRegistrationRoot("c:/code/gone", plainFolder))
      .resolves.toEqual({ ok: true, directoryPath: "c:/code/gone" });
  });
});

it.runIf(process.platform === "win32")("uses the case stored on disk for a Windows folder", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-registration-case-")));
  try {
    const folder = path.join(root, "MixedCase");
    await mkdir(folder);
    const directoryPath = canonicalizeNavigationPath(await realpath(folder));
    await expect(registerDirectoryFromDisk({ path: path.join(root, "mixedcase") }, {
      ensureDirectoryLaunchpad: mockLaunchpad(),
      runGit: async () => "",
    })).resolves.toMatchObject({ ok: true, directoryPath, directoryKey: `directory:${directoryPath}` });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("registers Git's primary checkout from any folder inside a linked worktree", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-project-registration-")));
  try {
    const repo = path.join(root, "parent-repo");
    const checkouts = [
      path.join(root, ".codex", "worktrees", "session", "parent-repo"),
      path.join(root, "custom folder", "different checkout name"),
    ];
    await mkdir(repo);
    await runGitCommand(repo, ["init", "-b", "main"]);
    await runGitCommand(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
    for (const checkout of checkouts) {
      await runGitCommand(repo, ["worktree", "add", "--detach", checkout]);
      await mkdir(path.join(checkout, "source", "nested"), { recursive: true });
    }
    const [primary] = (await runGitCommand(repo, ["worktree", "list", "--porcelain"])).stdout.split("\n");
    expect(primary).toBe(`worktree ${canonicalizeNavigationPath(repo)}`);
    const directoryPath = primary!.slice("worktree ".length);

    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...checkouts), fc.constantFrom([], ["source"], ["source", "nested"]),
      async (checkout, relative) => {
        const ensureDirectoryLaunchpad = mockLaunchpad();
        const result = await registerDirectoryFromDisk({ path: path.join(checkout, ...relative) }, { ensureDirectoryLaunchpad });
        const expected = { directoryPath, directoryKey: `directory:${directoryPath}`, directoryLabel: "parent-repo", currentBranch: "main" };
        expect(result).toMatchObject({ ok: true, ...expected, checkoutPath: canonicalizeNavigationPath(checkout) });
        expect(ensureDirectoryLaunchpad).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
      },
    ), { numRuns: 12 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each(["separate Git directory", "submodule"])("registers the working root of a %s", async (layout) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-git-admin-path-")));
  try {
    const checkout = path.join(root, "checkout");
    if (layout === "separate Git directory") {
      await runGitCommand(root, ["init", "--separate-git-dir", path.join(root, "admin"), checkout]);
    } else {
      const source = path.join(root, "source");
      await runGitCommand(root, ["init", source]);
      await runGitCommand(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
      await runGitCommand(root, ["init"]);
      await runGitCommand(root, ["-c", "protocol.file.allow=always", "submodule", "add", source, "checkout"]);
    }
    const workingRoot = (await runGitCommand(checkout, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const child = path.join(checkout, "nested");
    await mkdir(child);
    for (const selected of [checkout, child]) {
      const ensureDirectoryLaunchpad = mockLaunchpad();
      await expect(registerDirectoryFromDisk({ path: selected }, { ensureDirectoryLaunchpad })).resolves
        .toMatchObject({ ok: true, directoryPath: workingRoot, directoryKey: `directory:${workingRoot}` });
      expect(ensureDirectoryLaunchpad).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ directoryPath: workingRoot }));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
