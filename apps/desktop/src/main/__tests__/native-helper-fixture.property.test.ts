import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createNativeHelperFixture, runNativeFixtureCommand } from "../../test-setup/native-helper-fixture";
import { nativeHelperConsumers } from "../../test-setup/native-helper-fixtures";
import { isProcessIdAlive } from "../process-tree";

describe("native helper fixture ownership", () => {
  it("requires only the native helpers used by the selected files", () => {
    const cargo = path.resolve("apps/desktop/src/main/__tests__/maintenance-cargo-output.property.test.ts");
    const ipc = path.resolve("apps/desktop/src/main/__tests__/mcp-ipc-http.test.ts");
    fc.assert(fc.property(fc.array(fc.constantFrom(cargo, ipc, path.resolve("unrelated.test.ts"))), (files) => {
      expect(nativeHelperConsumers(files)).toEqual([
        ...(files.includes(cargo) ? ["maintenanceCargo"] : []),
        ...(files.includes(ipc) ? ["mcpIpc"] : []),
      ]);
    }));
  });

  // Model: requesting teardown does not transfer output ownership away from
  // an unfinished compiler, whether that compiler later succeeds or fails.
  it("joins preparation before deleting output, including failed preparation", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 4 }), async (fails, disposals) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const failure = new Error("controlled compiler failure");
      const fixture = createNativeHelperFixture(async (root) => {
        writeFileSync(path.join(root, "main.obj"), "compiler owns this output");
        await gate;
        if (fails) throw failure;
        return "compiled helper";
      });
      const result = fixture.ready.catch((error: unknown) => error);
      const cleanups = Array.from({ length: disposals }, () => fixture.dispose());
      try {
        await Promise.resolve();
        expect(existsSync(path.join(fixture.root, "main.obj"))).toBe(true);
      } finally {
        release();
        await Promise.all([result, ...cleanups]);
      }
      expect(await result).toBe(fails ? failure : "compiled helper");
      expect(existsSync(fixture.root)).toBe(false);
    }), { numRuns: 12 });
  });

  // The process table and filesystem are independent oracles. The driver
  // exits before its compiler, which closes stdio but still owns main.obj.
  // Finite Windows builds retire that descendant; POSIX waits for completion.
  it.each([0, 7])("drains a compiler descendant after driver exit %s before publishing readiness or removing files", async (exitCode) => {
    const control = mkdtempSync(path.join(os.tmpdir(), "native-compiler-control-"));
    const entered = path.join(control, "entered"), release = path.join(control, "release");
    const done = path.join(control, "done");
    const driverPid = path.join(control, "driver");
    const driverExit = path.join(control, "driver-exit");
    const compiler = `
      const fs = require("node:fs");
      const [root, entered, release, done] = process.argv.slice(1);
      const object = require("node:path").join(root, "main.obj");
      fs.writeFileSync(object, "compiling");
      fs.writeFileSync(entered, String(process.pid));
      function compile() {
        if (!fs.existsSync(release)) return setTimeout(compile, 10);
        fs.writeFileSync(object, "compiled");
        fs.writeFileSync(done, "finished");
      }
      compile();
    `;
    const fixture = createNativeHelperFixture(async (root) => {
      const driver = `
        require("node:fs").writeFileSync(${JSON.stringify(driverPid)}, String(process.pid));
        // Bypass Node's own kill-child-on-exit Job on Windows. Detachment
        // does not request Job breakaway, so PwrAgent still owns the compiler.
        const child = require("node:child_process").spawn(process.execPath,
          ["-e", ${JSON.stringify(compiler)}, ...process.argv.slice(1)],
          { stdio: "ignore", detached: process.platform === "win32" });
        child.unref();
        function finishDriver() {
          if (!require("node:fs").existsSync(${JSON.stringify(driverExit)})) return setTimeout(finishDriver, 10);
          process.exitCode = ${exitCode};
        }
        finishDriver();
      `;
      await runNativeFixtureCommand(process.execPath, ["-e", driver, root, entered, release, done]);
    });
    let settled = false;
    const result = fixture.ready.catch((error: unknown) => error).finally(() => { settled = true; });
    let cleanup: Promise<void> | undefined;
    try {
      await vi.waitFor(() => {
        expect(existsSync(entered)).toBe(true);
        expect(isProcessIdAlive(Number(readFileSync(driverPid, "utf8")))).toBe(true);
      }, { timeout: 5_000 });
      expect(settled).toBe(false);
      cleanup = fixture.dispose();
      await Promise.resolve();
      expect(existsSync(path.join(fixture.root, "main.obj"))).toBe(true);
      writeFileSync(driverExit, "driver finished");
      if (process.platform !== "win32") {
        await vi.waitFor(() => expect(isProcessIdAlive(Number(readFileSync(driverPid, "utf8")))).toBe(false));
        expect(settled).toBe(false);
        writeFileSync(release, "finish compilation");
      }
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
      await result;
      expect(isProcessIdAlive(Number(readFileSync(entered, "utf8")))).toBe(false);
      expect(existsSync(done)).toBe(process.platform !== "win32");
    } finally {
      writeFileSync(driverExit, "driver finished");
      writeFileSync(release, "finish compilation");
      await result;
      await vi.waitFor(() => {
        expect(isProcessIdAlive(Number(readFileSync(entered, "utf8")))).toBe(false);
      }, { timeout: 5_000 });
      await (cleanup ?? fixture.dispose());
      rmSync(control, { recursive: true, force: true });
    }
    if (exitCode === 0) expect(await result).toBeUndefined();
    else expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("exited 7") }));
    expect(existsSync(fixture.root)).toBe(false);
  });
});
