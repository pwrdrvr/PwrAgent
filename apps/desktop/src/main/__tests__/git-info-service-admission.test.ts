import { afterEach, expect, it, vi } from "vitest";
import { GitDirectoryService } from "../app-server/git-directory-service";
import { GitWorkingStateService } from "../app-server/git-working-state-service";

const error = vi.hoisted(() => vi.fn());
vi.mock("../log", () => ({
  getMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error }),
}));

afterEach(() => vi.restoreAllMocks());

it("directory and working-state entry APIs share the production user-refresh allowance", async () => {
  vi.spyOn(performance, "now").mockReturnValue(performance.now());
  const directoryGit = vi.fn(async () => "");
  const workingGit = vi.fn(async () => "");
  const directories = new GitDirectoryService({ runGit: directoryGit });
  const working = new GitWorkingStateService({ runGit: workingGit });
  const path = "/fixture/git-admission";
  await directories.readDirectoryStatus({ path });
  await working.readWorkingState(path);
  const directoryCommands = directoryGit.mock.calls.length;
  const workingCommands = workingGit.mock.calls.length;
  expect(directoryCommands).toBeGreaterThan(0);
  expect(workingCommands).toBeGreaterThan(0);
  directoryGit.mockClear();
  workingGit.mockClear();

  for (let index = 0; index < 120; index += 1) {
    const request = { userAction: true, caller: "buggy-hover" };
    const entries = index % 2 === 0
      ? directories.readDirectoryStatusEntries([{ key: "fixture", path }], request)
      : working.readWorkingStateEntries([path], request);
    for await (const entry of entries) expect(entry).toBeDefined();
  }

  expect(directoryGit.mock.calls.length).toBe(directoryCommands * 5);
  expect(workingGit.mock.calls.length).toBe(workingCommands * 5);
  expect(error).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith("Git user refresh budget exhausted", expect.objectContaining({ caller: "buggy-hover" }));
});
