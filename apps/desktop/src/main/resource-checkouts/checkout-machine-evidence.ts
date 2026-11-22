import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function readMachineCheckoutEvidence(): Promise<{ hostBinding?: string; bootId?: string }> {
  if (process.platform === "linux") {
    const [host, boot] = await Promise.all([readId("/etc/machine-id"), readId("/proc/sys/kernel/random/boot_id")]);
    return { hostBinding: hashIdentity(host), bootId: boot };
  }
  if (process.platform === "darwin") {
    const [platform, boot] = await Promise.all([
      run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
      run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]),
    ]);
    return { hostBinding: hashIdentity(platform?.match(/"IOPlatformUUID" = "([a-f\d-]+)"/i)?.[1]), bootId: parseId(boot) };
  }
  if (process.platform === "win32" && process.env.SystemRoot) {
    const platform = await run(`${process.env.SystemRoot}\\System32\\reg.exe`, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]);
    return { hostBinding: hashIdentity(platform?.match(/MachineGuid\s+REG_SZ\s+([a-f\d-]+)/i)?.[1]) };
  }
  return {};
}

function parseId(value?: string): string | undefined {
  const id = value?.trim().toLowerCase();
  return id && /^[a-f\d-]{32,36}$/.test(id) ? id : undefined;
}

function hashIdentity(value?: string): string | undefined {
  const id = parseId(value);
  return id ? createHash("sha256").update(id).digest("hex") : undefined;
}

async function readId(path: string): Promise<string | undefined> {
  return parseId(await readFile(path, "utf8").catch(() => undefined));
}

async function run(file: string, args: string[]): Promise<string | undefined> {
  return (await exec(file, args, { timeout: 1_500, windowsHide: true }).catch(() => undefined))?.stdout;
}

/** A reused ID can only block recovery. Never signal a persisted group. */
export function isEnvironmentGroupGone(pid: number): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
