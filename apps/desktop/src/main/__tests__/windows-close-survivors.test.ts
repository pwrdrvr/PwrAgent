import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWindowsCloseSurvivorReport,
  parseWindowsProcessSnapshot,
  selectWindowsCloseSurvivors,
  summarizeWindowsCommandLine,
  watchWindowsLauncherCloseGap,
  type WindowsProcessRow,
} from "../../../e2e/fixtures/windows-close-survivors";

const QUIT = 100_000;
const MAIN = { pid: 20, startedAt: 90_000 };

function row(
  pid: number,
  parentPid: number,
  startedAt: number,
  name: string,
  commandLine = name,
): WindowsProcessRow {
  return { pid, parentPid, startedAt, name, commandLine };
}

describe("Windows close survivor snapshot", () => {
  it("walks the launcher and main trees and keeps orphans of the launch separate", () => {
    const rows = [
      row(1, 0, 1_000, "worker.exe"),
      row(10, 1, 89_900, "cmd.exe"),
      row(20, 10, 90_000, "electron.exe"),
      row(21, 20, 95_000, "git.exe"),
      row(22, 21, 95_100, "git.exe"),
      // Parent 30 has exited; its child started during the launch.
      row(31, 30, 96_000, "powershell.exe"),
      row(32, 31, 96_500, "csc.exe"),
      // Started before the launch with a dead parent: not this launch's.
      row(40, 39, 50_000, "svchost.exe"),
      // Unrelated live process tree.
      row(50, 1, 97_000, "node.exe"),
    ];

    expect(
      selectWindowsCloseSurvivors(rows, {
        launcherPid: 10,
        mainProcess: MAIN,
        quitStartedAt: QUIT,
      }).map(({ pid, relation }) => [pid, relation]),
    ).toEqual([
      [10, "launcher"],
      [20, "main"],
      [21, "descendant"],
      [22, "descendant"],
      [31, "orphan"],
      [32, "orphan"],
    ]);
  });

  it("does not adopt children through a recycled main PID", () => {
    const rows = [
      row(1, 0, 1_000, "explorer.exe"),
      // PID 20 now belongs to a newer process.
      row(20, 1, 99_000, "notepad.exe"),
      row(21, 20, 95_000, "git.exe"),
    ];

    expect(
      selectWindowsCloseSurvivors(rows, {
        mainProcess: MAIN,
        quitStartedAt: QUIT,
      }).map(({ pid, relation }) => [pid, relation]),
    ).toEqual([[21, "orphan"]]);
  });

  it("reports nothing for orphans when the main identity is unknown", () => {
    expect(
      selectWindowsCloseSurvivors([row(31, 30, 96_000, "git.exe")], {
        quitStartedAt: QUIT,
      }),
    ).toEqual([]);
  });

  it("builds a bounded report with quit-relative timings", () => {
    const report = buildWindowsCloseSurvivorReport({
      launchId: "launch-1",
      reason: "graceful-close-timeout",
      rows: [
        row(10, 1, 89_900, "cmd.exe"),
        row(21, 20, 101_000, "git.exe", "git.exe -C D:\\repo status"),
      ],
      launcherPid: 10,
      mainProcess: MAIN,
      quitStartedAt: QUIT,
      snapshotAt: QUIT + 6_500,
    });

    expect(report).toEqual({
      launchId: "launch-1",
      reason: "graceful-close-timeout",
      launcherAlive: true,
      mainAlive: false,
      snapshotAfterQuitMs: 6_500,
      survivors: [
        {
          pid: 10,
          parentPid: 1,
          name: "cmd.exe",
          relation: "launcher",
          startedAfterQuitMs: -10_100,
          command: "cmd.exe",
        },
        {
          pid: 21,
          parentPid: 20,
          name: "git.exe",
          relation: "orphan",
          startedAfterQuitMs: 1_000,
          command: "git.exe -C D:\\repo status",
        },
      ],
      omittedSurvivors: 0,
    });
  });

  it("redacts long opaque arguments and truncates long command lines", () => {
    expect(
      summarizeWindowsCommandLine(
        `powershell.exe  -EncodedCommand ${"A".repeat(64)}\r\n`,
      ),
    ).toBe("powershell.exe -EncodedCommand <redacted>");
    expect(summarizeWindowsCommandLine("x ".repeat(200))).toHaveLength(241);
  });

  it("parses the PowerShell snapshot format and skips malformed lines", () => {
    const command = Buffer.from("git.exe status", "utf8").toString("base64");
    expect(
      parseWindowsProcessSnapshot(
        `21\t20\t95000\tgit.exe\t${command}\r\nnot a row\r\n\r\n`,
      ),
    ).toEqual([row(21, 20, 95_000, "git.exe", "git.exe status")]);
  });

  describe("launcher close gap", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function fakeLauncher(): ChildProcess {
      return Object.assign(new EventEmitter(), { pid: 10 }) as unknown as ChildProcess;
    }

    it("takes no snapshot when the launcher closes promptly after exit", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const launcher = fakeLauncher();
      const watch = watchWindowsLauncherCloseGap(launcher, {
        launchId: "launch-1",
        quitStartedAt: Date.now(),
      });
      launcher.emit("exit", 0, null);
      launcher.emit("close", 0, null);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await watch.settled();
      expect(log).not.toHaveBeenCalled();
      expect(launcher.listenerCount("exit")).toBe(0);
      expect(launcher.listenerCount("close")).toBe(0);
    });

    it("reports once when the launcher's pipes stay open past the gap", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const launcher = fakeLauncher();
      const watch = watchWindowsLauncherCloseGap(launcher, {
        launchId: "launch-2",
        quitStartedAt: Date.now(),
      });
      launcher.emit("exit", 0, null);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await watch.settled();
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line.startsWith("[pwragent-e2e-close-survivors] ")).toBe(true);
      expect(JSON.parse(line.slice(line.indexOf("{")))).toMatchObject({
        launchId: "launch-2",
        reason: "launcher-close-gap",
      });
    }, 10_000);
  });
});
