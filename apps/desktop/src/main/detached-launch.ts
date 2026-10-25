import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Start a process that outlives this one, without handing it this process's
 * open files.
 *
 * libuv's spawn closes only close-on-exec descriptors in the child. On Linux,
 * Chromium opens many descriptors without that flag: its IPC sockets, Local
 * Storage files, shared-memory files, and the DevTools listener and
 * connections. A plain detached `spawn` gives all of them to the new process,
 * which keeps them open after this process exits. A remote-debugging client
 * then never sees end-of-file on its connection. In one measured profile
 * relaunch, the new instance held about 70 of the old instance's
 * descriptors, including its DevTools listener and the open CDP connection.
 *
 * Node cannot set close-on-exec on a descriptor it did not open, and it has
 * no "close other descriptors" spawn option. So on Linux this process lists
 * its own inheritable descriptors, then starts a short Electron-as-Node
 * trampoline. The trampoline closes exactly those descriptors and `execve`s
 * the target. Each descriptor is matched by device and inode as well as by
 * number, because another thread can close a listed descriptor before the
 * fork. The trampoline could then reuse that number for one of its own
 * descriptors, and the identity check keeps that descriptor open.
 *
 * The trampoline's own few inheritable descriptors (its V8 snapshot file and
 * a Chromium event poller) still pass to the target. They belong to no live
 * process once `execve` replaces the trampoline.
 *
 * macOS needs no trampoline: libuv spawns there with
 * `POSIX_SPAWN_CLOEXEC_DEFAULT`, which closes every descriptor it does not
 * map. Windows handles are not inheritable unless created so, and Chromium
 * does not create them so.
 */
export function spawnDetachedProcess(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: {
    inheritableDescriptors?: () => InheritableDescriptor[];
    platform?: NodeJS.Platform;
    trampolineExecPath?: string;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    spawn(file, [...args], { detached: true, env, stdio: "ignore" }).unref();
    return;
  }

  const spec: DetachedLaunchSpec = {
    file,
    args: [...args],
    close: (options.inheritableDescriptors ?? listInheritableDescriptors)(),
  };
  const child = spawn(
    options.trampolineExecPath ?? process.execPath,
    ["-e", DETACHED_LAUNCH_TRAMPOLINE],
    {
      detached: true,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        [DETACHED_LAUNCH_SPEC_ENV]: JSON.stringify(spec),
      },
      stdio: "ignore",
    },
  );
  child.unref();
}

export type InheritableDescriptor = {
  fd: number;
  dev: string;
  ino: string;
};

type DetachedLaunchSpec = {
  file: string;
  args: string[];
  close: InheritableDescriptor[];
};

export const DETACHED_LAUNCH_SPEC_ENV = "PWRAGENT_DETACHED_LAUNCH_SPEC";

// O_CLOEXEC as /proc/<pid>/fdinfo reports it in the octal `flags:` field.
const O_CLOEXEC = 0o2000000;

/**
 * This process's descriptors above stderr that an exec would keep open.
 * Linux only; another platform, or an unreadable `/proc`, reports none.
 */
export function listInheritableDescriptors(): InheritableDescriptor[] {
  let names: string[];
  try {
    names = fs.readdirSync("/proc/self/fd");
  } catch {
    return [];
  }
  const descriptors: InheritableDescriptor[] = [];
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 2) {
      continue;
    }
    try {
      const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
      const flags = /^flags:\s+([0-7]+)/m.exec(info)?.[1];
      if (flags === undefined || (parseInt(flags, 8) & O_CLOEXEC) !== 0) {
        continue;
      }
      const stat = fs.fstatSync(fd, { bigint: true });
      descriptors.push({ fd, dev: String(stat.dev), ino: String(stat.ino) });
    } catch {
      // Closed while we looked (including the directory read's own
      // descriptor). Nothing to close in the child.
    }
  }
  return descriptors;
}

// Runs as `electron -e` with ELECTRON_RUN_AS_NODE=1, so it is plain
// CommonJS for the Node inside Electron. It removes both variables it was
// given before the target starts: the target is Electron, not Node.
export const DETACHED_LAUNCH_TRAMPOLINE = `
const fs = require("node:fs");
const spec = JSON.parse(process.env.${DETACHED_LAUNCH_SPEC_ENV});
delete process.env.${DETACHED_LAUNCH_SPEC_ENV};
delete process.env.ELECTRON_RUN_AS_NODE;
for (const { fd, dev, ino } of spec.close) {
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (String(stat.dev) === dev && String(stat.ino) === ino) fs.closeSync(fd);
  } catch {}
}
if (typeof process.execve === "function") {
  process.execve(spec.file, [spec.file, ...spec.args], process.env);
} else {
  require("node:child_process")
    .spawn(spec.file, spec.args, { detached: true, stdio: "ignore" })
    .unref();
}
`;
