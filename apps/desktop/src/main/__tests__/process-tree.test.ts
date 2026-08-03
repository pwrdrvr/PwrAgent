import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { terminateOwnedProcessTree } from "../process-tree";

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("terminateOwnedProcessTree", () => {
  posixOnly("escalates and kills resistant descendants", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => undefined);',
      "const descendant = spawn(process.execPath, [\"-e\", \"process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)\"], { stdio: \"ignore\" });",
      'process.stdout.write(String(descendant.pid) + "\\n");',
      "setInterval(() => undefined, 1000);",
    ].join(" ");
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const [line] = await once(child.stdout!, "data");
      const descendantPid = Number(String(line).trim());

      await terminateOwnedProcessTree(child, {
        gracefulTimeoutMs: 25,
        forceTimeoutMs: 1_000,
      });

      expect(() => process.kill(child.pid!, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The expected path already terminated the entire process group.
      }
    }
  });
});
