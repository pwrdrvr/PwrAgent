import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureMaintenanceAllocation, measureMaintenanceAllocationPaths } from "../app-server/maintenance-disk-usage";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("Windows maintenance allocation protocol", () => {
  it("regression: preserves a measured zero as known allocation", async () => {
    vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? "win32" : Reflect.get(target, key) }));
    execute.mockResolvedValue({ stdout: "{\"allocatedBytes\":0}" });
    expect(await measureMaintenanceAllocation("/owned/checkout", new AbortController().signal)).toEqual({ allocatedBytes: 0 });
  });

  // The native result owns allocation; logical file sizes are never a fallback.
  it("preserves native zero, allocation and lower bounds for either entry point", async () => {
    vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? "win32" : Reflect.get(target, key) }));
    await fc.assert(fc.asyncProperty(fc.nat({ max: Number.MAX_SAFE_INTEGER }), fc.boolean(), async (allocatedBytes, lowerBound) => {
      const space = { allocatedBytes, ...(lowerBound ? { lowerBound: true } : {}) };
      execute.mockResolvedValue({ stdout: JSON.stringify(space) });
      const signal = new AbortController().signal;
      expect(await measureMaintenanceAllocation("/owned/checkout", signal)).toEqual(space);
      expect(await measureMaintenanceAllocationPaths(["/owned/checkout/deps", "/owned/checkout/build"], signal)).toEqual(space);
      expect(execute.mock.calls.at(-1)![1][0]).toBe("--maintenance-allocation");
      expect(execute.mock.calls.at(-1)![2]).toMatchObject({ signal, timeout: 30_000, maxBuffer: 8192, windowsHide: true });
    }), { numRuns: 30 });
  });

  it("keeps failed, malformed and unsafe results unknown", async () => {
    vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? "win32" : Reflect.get(target, key) }));
    for (const value of ["", "{}", "null", "[]", "{\"allocatedBytes\":-1}", "{\"allocatedBytes\":1.5}",
      "{\"allocatedBytes\":9007199254740992}", "{\"allocatedBytes\":\"8192\"}", "{\"allocatedBytes\":0,\"lowerBound\":\"false\"}"]) {
      execute.mockResolvedValue({ stdout: value });
      expect(await measureMaintenanceAllocation("/owned/checkout", new AbortController().signal)).toBeUndefined();
    }
    for (const code of ["ENOENT", "EACCES", "ABORT_ERR", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
      execute.mockRejectedValue(Object.assign(new Error(code), { code }));
      expect(await measureMaintenanceAllocationPaths(["/owned/checkout/deps"], new AbortController().signal)).toBeUndefined();
    }
    execute.mockClear();
    expect(await measureMaintenanceAllocationPaths([], new AbortController().signal)).toEqual({ allocatedBytes: 0 });
    expect(await measureMaintenanceAllocationPaths(Array.from({ length: 1001 }, () => "/owned/checkout/deps"), new AbortController().signal)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
