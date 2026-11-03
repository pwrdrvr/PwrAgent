import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { snapshotWindowsProcessTreeIds, windowsProcessTreeIds } from "../windows-process-tree";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const processRow = (pid: number, ppid: number, created: number) => ({
  pid, ppid, created: String(created),
});

describe("Windows process-tree snapshot", () => {
  it("selects only descendants from one table, including grandchildren", () => {
    const rows = [
      processRow(1, 0, 1),
      processRow(20, 1, 20),
      processRow(21, 20, 21),
      processRow(22, 21, 22),
      processRow(30, 1, 30),
      processRow(31, 30, 31),
    ];
    expect(windowsProcessTreeIds(JSON.stringify(rows), 20)).toEqual([20, 21, 22]);
  });

  it("does not adopt an old child whose recorded parent PID was reused", () => {
    const rows = [
      processRow(20, 1, 200),
      processRow(21, 20, 100),
      processRow(22, 21, 110),
      processRow(23, 20, 210),
    ];
    expect(windowsProcessTreeIds(JSON.stringify(rows), 20)).toEqual([20, 23]);
  });

  it("does not adopt reparented children when the root is already gone", () => {
    expect(windowsProcessTreeIds(JSON.stringify([
      processRow(21, 20, 100),
    ]), 20)).toEqual([20]);
  });

  it("accepts a single CIM row and ignores invalid process identities", () => {
    expect(windowsProcessTreeIds(JSON.stringify(processRow(20, 1, 100)), 20)).toEqual([20]);
    expect(windowsProcessTreeIds(JSON.stringify([
      processRow(20, 1, 100),
      { pid: 21, ppid: 20, created: null },
      { pid: 22, ppid: 20, created: "invalid" },
      { pid: -1, ppid: 20, created: "110" },
    ]), 20)).toEqual([20]);
  });

  it("performs one bounded CIM query even when the command keeps spawning children", () => {
    const query = vi.mocked(spawnSync);
    query.mockReset();
    const table = [processRow(20, 1, 100), processRow(21, 20, 110)];
    query.mockImplementation(() => {
      // A moving walk sees a new child on every query and never converges.
      table.push(processRow(20 + table.length, 20, 100 + table.length));
      return { status: 0, stdout: JSON.stringify(table) } as ReturnType<typeof spawnSync>;
    });
    expect(snapshotWindowsProcessTreeIds("powershell.exe", 20)).toEqual([20, 21, 22]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("powershell.exe", expect.any(Array), expect.objectContaining({
      timeout: 5_000,
      windowsHide: true,
    }));
  });
});
