import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitDirectoryService } from "../app-server/git-directory-service";

vi.mock("../log", () => ({
  getMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
afterEach(() => vi.restoreAllMocks());

it("refreshes nested branch/worktree inventory only when the user bypass is admitted", async () => {
  vi.spyOn(performance, "now").mockReturnValue(performance.now());
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const cwd = path.resolve("/fixture/inventory");
  let branches = ["main", "release"];
  let occupied = false;
  const runGit = vi.fn(async (_cwd: string, args: string[]) => {
    if (args.includes("--show-toplevel")) return cwd;
    if (args.includes("--git-common-dir")) return path.join(cwd, ".git");
    if (args.includes("--is-inside-work-tree")) return "true";
    if (args.includes("@{upstream}")) return "";
    if (args.includes("--abbrev-ref") || args.includes("--show-current")) return "main";
    if (args[0] === "for-each-ref") {
      return branches.map((branch) => args.includes("refs/remotes")
        ? `refs/heads/${branch}\t${branch}\t100\t`
        : `${branch}\t100`).join("\n");
    }
    if (args[0] === "worktree") return `worktree ${cwd}\nbranch refs/heads/main\n\n`
      + (occupied ? `worktree ${cwd}-release\nbranch refs/heads/release\n\n` : "");
    return "";
  });
  const service = new GitDirectoryService({ runGit });
  expect((await service.readDirectoryStatus({ path: cwd }))?.branches).toEqual(["main", "release"]);

  branches = ["main", "release", "fresh"];
  occupied = true;
  const refreshed = await service.readDirectoryStatus({ path: cwd }, { userAction: true });
  expect(refreshed?.branches).toContain("fresh");
  expect(refreshed?.branchDetails).toContainEqual(expect.objectContaining({ name: "release", inUse: true }));
  expect(refreshed?.handoffBranches).not.toContain("release");

  for (let index = 0; index < 9; index += 1) await service.readDirectoryStatus({ path: cwd }, { userAction: true });
  const commands = runGit.mock.calls.length;
  branches = [...branches, "denied"];
  for (let index = 0; index < 120; index += 1) {
    expect((await service.readDirectoryStatus({ path: cwd }, { userAction: true }))?.branches).not.toContain("denied");
  }
  expect(runGit.mock.calls.length).toBe(commands);
});
