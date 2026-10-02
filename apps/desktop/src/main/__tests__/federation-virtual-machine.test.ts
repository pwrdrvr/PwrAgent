import { describe, expect, it } from "vitest";
import {
  namesHypervisor,
  probeVirtualMachine,
  type VirtualMachineProbe,
} from "../federation/federation-virtual-machine";

function probe(
  platform: NodeJS.Platform,
  files: Record<string, string> = {},
  output?: string | Error,
): VirtualMachineProbe {
  return {
    platform,
    readFile: async (filePath) => {
      if (filePath in files) return files[filePath];
      throw new Error(`ENOENT: ${filePath}`);
    },
    run: async () => {
      if (output instanceof Error || output === undefined) throw output ?? new Error("no command");
      return output;
    },
  };
}

describe("namesHypervisor", () => {
  it.each([
    ["QEMU", true],
    ["VMware, Inc.", true],
    ["Microsoft Corporation Virtual Machine", true],
    ["Parallels Software International Inc.", true],
    ["innotek GmbH VirtualBox", true],
    ["Dell Inc. XPS 8960", false],
    ["Apple Inc. Mac15,9", false],
  ])("%s -> %s", (text, expected) => {
    expect(namesHypervisor(text)).toBe(expected);
  });
});

describe("probeVirtualMachine", () => {
  it("reads Linux DMI, then the cpuinfo hypervisor flag", async () => {
    expect(await probeVirtualMachine(probe("linux", {
      "/sys/class/dmi/id/sys_vendor": "QEMU\n",
    }))).toBe(true);
    expect(await probeVirtualMachine(probe("linux", {
      "/proc/cpuinfo": "processor\t: 0\nflags\t\t: fpu vme hypervisor lahf_lm\n",
    }))).toBe(true);
    expect(await probeVirtualMachine(probe("linux", {
      "/sys/class/dmi/id/sys_vendor": "Dell Inc.\n",
      "/proc/cpuinfo": "flags\t\t: fpu vme lahf_lm\n",
    }))).toBe(false);
    // Nothing readable is unknown, never bare metal.
    expect(await probeVirtualMachine(probe("linux"))).toBeUndefined();
  });

  it("reads kern.hv_vmm_present on macOS", async () => {
    expect(await probeVirtualMachine(probe("darwin", {}, "1\n"))).toBe(true);
    expect(await probeVirtualMachine(probe("darwin", {}, "0\n"))).toBe(false);
    expect(await probeVirtualMachine(probe("darwin", {}, "unknown oid\n"))).toBeUndefined();
    expect(await probeVirtualMachine(probe("darwin", {}, new Error("timed out")))).toBeUndefined();
  });

  it("reads the BIOS manufacturer and product on Windows", async () => {
    const bios = (manufacturer: string, product: string) => [
      "HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\BIOS",
      "    BIOSVendor    REG_SZ    American Megatrends Inc.",
      `    SystemManufacturer    REG_SZ    ${manufacturer}`,
      `    SystemProductName    REG_SZ    ${product}`,
    ].join("\r\n");
    expect(await probeVirtualMachine(probe("win32", {}, bios("Microsoft Corporation", "Virtual Machine")))).toBe(true);
    expect(await probeVirtualMachine(probe("win32", {}, bios("Dell Inc.", "XPS 8960")))).toBe(false);
    expect(await probeVirtualMachine(probe("win32", {}, "ERROR: The system was unable to find the key"))).toBeUndefined();
  });
});
