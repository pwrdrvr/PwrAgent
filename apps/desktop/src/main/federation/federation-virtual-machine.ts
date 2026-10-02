import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

/**
 * Best-effort guest detection for the host facts a federation instance
 * advertises. The short-name helper uses it to call a machine a VM; nothing
 * else depends on it, so every failure answers "unknown" (undefined) rather
 * than guessing, and a peer must never read undefined as bare metal.
 *
 * One probe per platform, run once per process:
 * - Linux: the DMI vendor and product files, then the cpuinfo
 *   `hypervisor` flag. File reads only.
 * - macOS: `sysctl -n kern.hv_vmm_present`, which the kernel sets to 1 in
 *   a Virtualization.framework (Tart, UTM, Parallels) guest.
 * - Windows: the BIOS key under HKLM\HARDWARE, which hypervisors brand
 *   ("Virtual Machine" for Hyper-V, "VMware…", "Parallels…").
 */

const HYPERVISOR_PATTERN =
  /\b(?:kvm|qemu|vmware|virtualbox|vbox|xen|hyper-v|virtual machine|parallels|bochs|bhyve|utm|apple virtual)\b/i;

const PROBE_TIMEOUT_MS = 2_000;

export type VirtualMachineProbe = {
  platform: NodeJS.Platform;
  readFile: (filePath: string) => Promise<string>;
  run: (command: string, args: string[]) => Promise<string>;
};

/** Whether vendor, product, or manufacturer text names a hypervisor. */
export function namesHypervisor(text: string): boolean {
  return HYPERVISOR_PATTERN.test(text);
}

export async function probeVirtualMachine(
  probe: VirtualMachineProbe,
): Promise<boolean | undefined> {
  try {
    switch (probe.platform) {
      case "linux":
        return await probeLinux(probe);
      case "darwin": {
        const value = (await probe.run("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"])).trim();
        return value === "1" ? true : value === "0" ? false : undefined;
      }
      case "win32": {
        const bios = await probe.run("reg", [
          "query",
          "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS",
        ]);
        const facts = bios
          .split(/\r?\n/)
          .filter((line) => /\b(?:SystemManufacturer|SystemProductName)\b/.test(line))
          .join("\n");
        return facts ? namesHypervisor(facts) : undefined;
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

async function probeLinux(probe: VirtualMachineProbe): Promise<boolean | undefined> {
  let readAny = false;
  for (const file of ["/sys/class/dmi/id/sys_vendor", "/sys/class/dmi/id/product_name"]) {
    try {
      const text = await probe.readFile(file);
      readAny = true;
      if (namesHypervisor(text)) return true;
    } catch {
      // Unreadable in some containers; cpuinfo below still answers.
    }
  }
  try {
    const cpuinfo = await probe.readFile("/proc/cpuinfo");
    readAny = true;
    if (/^flags\s*:.*\bhypervisor\b/m.test(cpuinfo)) return true;
  } catch {
    // Neither source is readable: unknown.
  }
  return readAny ? false : undefined;
}

const defaultProbe: VirtualMachineProbe = {
  platform: process.platform,
  readFile: async (filePath) => await fs.readFile(filePath, "utf8"),
  run: async (command, args) => await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  }),
};

let cached: Promise<boolean | undefined> | undefined;

/** The host's answer, probed once per process. */
export function detectVirtualMachine(): Promise<boolean | undefined> {
  cached ??= probeVirtualMachine(defaultProbe);
  return cached;
}
