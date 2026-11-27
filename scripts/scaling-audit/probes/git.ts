import { record } from "./scaling-audit-results";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import * as gitExecutable from "../app-server/git-executable";
import { StackReader } from "../stacks/stack-reader";
import { isolateProcessGitEnvironment, runIsolatedGitSync } from "./helpers/isolated-git";

let restoreGit: (() => void) | undefined;

afterEach(() => {
  restoreGit?.();
  restoreGit = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return runIsolatedGitSync(cwd, args).trim();
}

function missingCheckoutError(cwd: string): Error {
  return Object.assign(new Error("not found"), {
    code: 128,
    killed: false,
    stderr: `fatal: cannot change to '${cwd}': No such file or directory\n`,
  });
}

function initialize(cwd: string): string {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", "trunk");
  return git(cwd, "rev-parse", "HEAD");
}

function row(cwd: string, id: string): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: id,
    titleSource: "explicit",
    gitBranch: "main",
    inbox: { inInbox: false },
    linkedDirectories: [{ id: cwd, path: cwd, kind: "local", label: id }],
  };
}

it.each([512,1024,2048,2060])("retains %i checkout verdicts",async count=>{
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-large-cap-")));
    restoreGit = isolateProcessGitEnvironment();
    const realRunGit = gitExecutable.runGitCommand;
    try {
      process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
      // 2,060 distinct missing directories crosses the historic 2,048 FIFO cap
      // while avoiding real git subprocesses via a fast mocked exit-128 oracle.

      const dirs = Array.from({ length: count }, (_, index) =>
        path.join(sandbox, `deleted-${String(index).padStart(4, "0")}`));
      const fixturePaths = new Set(dirs);
      const rows = dirs.map((dir, index) => row(dir, `deleted-${index}`));
      const preflight = dirs[0]!;
      let initialized = false;
      const runSpy = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
        if (args[0] === "rev-parse" && fixturePaths.has(cwd) && !(initialized && cwd === preflight)) {
          throw missingCheckoutError(cwd);
        }
        return await realRunGit(cwd, args, options);
      });
      try {
        let now = 0;
        const reader = new StackReader(() => now);
        const revParseCalls = () => runSpy.mock.calls
          .filter(([cwd, args]) => fixturePaths.has(cwd) && args[0] === "rev-parse").length;

        await reader.read(rows, []);
        record({kind:"git",stage:"cold",count,calls:revParseCalls()});

        // Warm repeat within TTL must keep 100% of the active inventory cached
        // (0 rev-parse spawns), never thrashing FIFO eviction back to 0% hits.
        runSpy.mockClear();
        await reader.read(rows, []);
        record({kind:"git",stage:"warm",count,calls:revParseCalls()});


        now+=31000;runSpy.mockClear();await reader.read(rows,[]);
        record({kind:"git",stage:"expired",count,calls:revParseCalls()});
        await mkdir(preflight); initialize(preflight); initialized=true;
        const check=await realRunGit(preflight,["rev-parse","--show-toplevel"]);
        expect(check.stdout.trim()).toBe(preflight);
      }finally{runSpy.mockRestore();}
    }finally{await rm(sandbox,{recursive:true,force:true});}
  });
