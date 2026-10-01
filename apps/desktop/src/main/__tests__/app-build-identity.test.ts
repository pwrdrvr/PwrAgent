import { beforeEach, expect, it, vi } from "vitest";
import { readAppBuildIdentity } from "../app-build-identity";

const runGitCommand = vi.hoisted(() => vi.fn());
vi.mock("../app-server/git-executable", () => ({ runGitCommand }));

beforeEach(() => {
  runGitCommand.mockReset();
});

it("identifies a packaged app without inspecting a local checkout", async () => {
  expect(await readAppBuildIdentity(true, "/Applications/PwrAgent.app/Contents/Resources/app.asar"))
    .toEqual({ kind: "packaged" });
  expect(runGitCommand).not.toHaveBeenCalled();
});

it("reads the development checkout path, branch, and full commit from the app path", async () => {
  const commitSha = "1234567890abcdef1234567890abcdef12345678";
  runGitCommand.mockResolvedValue({ stdout: `/repo/PwrAgent\n${commitSha}\nfix/composer\n` });
  expect(await readAppBuildIdentity(false, "/repo/PwrAgent/apps/desktop")).toEqual({
    kind: "development", appPath: "/repo/PwrAgent/apps/desktop", checkoutPath: "/repo/PwrAgent",
    branch: "fix/composer", commitSha,
  });
  expect(runGitCommand).toHaveBeenCalledWith("/repo/PwrAgent/apps/desktop",
    ["rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD"],
    { timeout: 2_000, maxBuffer: 64 * 1024 });
});

it("identifies a detached development checkout without treating HEAD as a branch", async () => {
  const commitSha = "1234567890abcdef1234567890abcdef12345678";
  runGitCommand.mockResolvedValue({ stdout: `/repo\n${commitSha}\nHEAD\n` });
  expect(await readAppBuildIdentity(false, "/repo/apps/desktop")).toEqual({
    kind: "development", appPath: "/repo/apps/desktop", checkoutPath: "/repo", commitSha,
    detachedHead: true,
  });
});

it("retains the development app path when Git identity cannot be read", async () => {
  runGitCommand.mockRejectedValue(new Error("Not a Git checkout"));
  expect(await readAppBuildIdentity(false, "/source-copy/apps/desktop"))
    .toEqual({ kind: "development", appPath: "/source-copy/apps/desktop" });
});
