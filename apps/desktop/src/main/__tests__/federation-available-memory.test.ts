import { describe, expect, it } from "vitest";
import {
  parseMemAvailableBytes,
  parseVmStatAvailableBytes,
  readAvailableMemoryBytes,
} from "../federation/federation-available-memory";

/** Trimmed to the fields the parser reads, in the real format. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               8500.
Pages active:                           500000.
Pages inactive:                         120000.
Pages speculative:                        3000.
Pages throttled:                             0.
Pages wired down:                       180000.
Pages purgeable:                         12000.
`;

describe("federation available memory", () => {
  it("counts reclaimable macOS pages, not just free ones", () => {
    // 8500 free + 120000 inactive + 3000 speculative = 131500 pages.
    expect(parseVmStatAvailableBytes(VM_STAT)).toBe(131_500 * 16_384);
  });

  it("does not add purgeable pages on top of the queues holding them", () => {
    // `Pages purgeable` is a property of pages already counted in the
    // active/inactive queues, not a disjoint class, so adding it would
    // overstate the headroom — the dangerous direction for a health card.
    const withMorePurgeable = VM_STAT.replace(
      "Pages purgeable:                         12000.",
      "Pages purgeable:                        999999.",
    );
    expect(parseVmStatAvailableBytes(withMorePurgeable)).toBe(
      parseVmStatAvailableBytes(VM_STAT),
    );
  });

  it("scales by the page size the header reports", () => {
    // Getting this wrong silently scales the answer by 4x on Apple silicon.
    const fourKib = VM_STAT.replace("page size of 16384", "page size of 4096");
    expect(parseVmStatAvailableBytes(fourKib)).toBe(131_500 * 4_096);
  });

  it("gives up on vm_stat output it cannot read", () => {
    expect(parseVmStatAvailableBytes("not vm_stat output")).toBeUndefined();
    expect(
      parseVmStatAvailableBytes("(page size of 4096 bytes)\nPages active: 1.\n"),
    ).toBeUndefined();
  });

  it("prefers the kernel's own MemAvailable on Linux", () => {
    expect(
      parseMemAvailableBytes(
        "MemTotal:       16316160 kB\nMemFree:          139264 kB\nMemAvailable:    2461696 kB\n",
      ),
    ).toBe(2_461_696 * 1024);
    expect(parseMemAvailableBytes("MemTotal: 16316160 kB\n")).toBeUndefined();
  });

  it("reads macOS through vm_stat", async () => {
    await expect(
      readAvailableMemoryBytes({
        platform: "darwin",
        runVmStat: async () => VM_STAT,
      }),
    ).resolves.toBe(131_500 * 16_384);
  });

  it("reads Linux through /proc/meminfo", async () => {
    await expect(
      readAvailableMemoryBytes({
        platform: "linux",
        readMemInfo: async () => "MemAvailable:    2461696 kB\n",
      }),
    ).resolves.toBe(2_461_696 * 1024);
  });

  it("falls back to free memory when sampling fails", async () => {
    // A wrong-but-present number beats a missing metric on a health card,
    // and free memory is only ever pessimistic.
    await expect(
      readAvailableMemoryBytes({
        platform: "darwin",
        runVmStat: async () => {
          throw new Error("vm_stat: command not found");
        },
        readFreeMemory: () => 4_096,
      }),
    ).resolves.toBe(4_096);
  });

  it("falls back when vm_stat answers with something unparsable", async () => {
    await expect(
      readAvailableMemoryBytes({
        platform: "darwin",
        runVmStat: async () => "surprise",
        readFreeMemory: () => 4_096,
      }),
    ).resolves.toBe(4_096);
  });

  it("uses free memory directly where it already means available", async () => {
    // Windows' os.freemem() maps to GlobalMemoryStatusEx.ullAvailPhys.
    await expect(
      readAvailableMemoryBytes({ platform: "win32", readFreeMemory: () => 4_096 }),
    ).resolves.toBe(4_096);
  });
});
