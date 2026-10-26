import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = fileURLToPath(new URL("../detached-launch.ts", import.meta.url));

// Writes the descriptor targets and the two trampoline variables it can see.
const TARGET = `
const fs = require("node:fs");
const fds = fs.readdirSync("/proc/self/fd").map((fd) => {
  try { return fs.readlinkSync("/proc/self/fd/" + fd); } catch { return ""; }
});
fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify({
  fds,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  spec: process.env.PWRAGENT_DETACHED_LAUNCH_SPEC ?? null,
}));
`;

// Stands in for the Electron main process. Bash gives it fd 57 without
// close-on-exec, the shape of a descriptor Chromium opened. (Node marks some
// low inherited descriptors close-on-exec at startup, so a low number would
// prove nothing.) It starts one target with a plain detached spawn, as the
// profile relaunch did, and one through the helper.
const PARENT = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { listInheritableDescriptors, spawnDetachedProcess } from ${JSON.stringify(helperPath)};
const dir = process.env.REPORT_DIR;
fs.writeFileSync(dir + "/parent.json", JSON.stringify({
  held: fs.readlinkSync("/proc/self/fd/57"),
  inheritable: listInheritableDescriptors().map(({ fd }) => fd),
}));
const target = ["-e", ${JSON.stringify(TARGET)}];
spawn(process.execPath, target, {
  detached: true,
  env: { ...process.env, REPORT_PATH: dir + "/plain.json" },
  stdio: "ignore",
}).unref();
spawnDetachedProcess(process.execPath, target, {
  ...process.env,
  REPORT_PATH: dir + "/helper.json",
});
`;

async function readReport(file: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`No report at ${file}`);
}

describe("spawnDetachedProcess", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "keeps the parent's inheritable descriptors out of the detached process",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-detached-launch-"));
      dirs.push(dir);
      const heldPath = path.join(dir, "held-by-parent");
      fs.writeFileSync(heldPath, "");
      const parent = spawn(
        "/bin/bash",
        [
          "-c",
          'exec 57<"$HELD_PATH"; exec "$@"',
          "bash",
          process.execPath,
          "--input-type=module",
          "-e",
          PARENT,
        ],
        {
          env: { ...process.env, HELD_PATH: heldPath, REPORT_DIR: dir },
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      const exitCode = await new Promise<number | null>((resolve) => {
        parent.once("exit", resolve);
      });
      expect(exitCode).toBe(0);

      const parentReport = await readReport(path.join(dir, "parent.json"));
      expect(parentReport.held).toBe(heldPath);
      expect(parentReport.inheritable).toContain(57);

      // The control proves the target can see a leaked descriptor.
      const plain = await readReport(path.join(dir, "plain.json"));
      expect(plain.fds).toContain(heldPath);

      const helper = await readReport(path.join(dir, "helper.json"));
      expect(helper.fds).not.toContain(heldPath);
      expect(helper.runAsNode).toBeNull();
      expect(helper.spec).toBeNull();
    },
    30_000,
  );
});
