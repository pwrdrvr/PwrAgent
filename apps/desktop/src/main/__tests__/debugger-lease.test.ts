import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { acquireDebuggerLease } from "../diagnostics/debugger-lease";

function connection() {
  let attached = false;
  const api = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; api.emit("detach", {}, "test"); }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async () => ({})),
  });
  return api;
}

describe("diagnostic debugger ownership", () => {
  it.each(["Profiler", "Tracing"] as const)("retains the attachment when %s releases first", (first) => {
    const api = connection();
    const cpu = acquireDebuggerLease(api, "Profiler");
    const trace = acquireDebuggerLease(api, "Tracing");
    expect(api.attach).toHaveBeenCalledOnce();
    expect(() => acquireDebuggerLease(api, "Profiler")).toThrow("already acquired");
    const owners = first === "Profiler" ? [cpu, trace] : [trace, cpu];
    owners[0].release();
    owners[0].release();
    expect(api.detach).not.toHaveBeenCalled();
    expect(owners[1].valid).toBe(true);
    owners[1].release();
    expect(api.detach).toHaveBeenCalledOnce();
    expect(api.listenerCount("detach")).toBe(0);
  });

  it("invalidates all old leases and does not detach a replacement connection", () => {
    const api = connection();
    const cpu = acquireDebuggerLease(api, "Profiler");
    const trace = acquireDebuggerLease(api, "Tracing");
    api.detach();
    api.attach("1.3");
    cpu.release();
    trace.release();
    expect(cpu.valid).toBe(false);
    expect(trace.valid).toBe(false);
    expect(api.detach).toHaveBeenCalledOnce();
    expect(() => acquireDebuggerLease(api, "Tracing")).toThrow("already attached");
  });

  it("releases a destroyed target without querying its native attachment", () => {
    const api = connection();
    const trace = acquireDebuggerLease(api, "Tracing");
    api.isAttached.mockClear();
    trace.release(true);
    expect(api.isAttached).not.toHaveBeenCalled();
    expect(api.detach).not.toHaveBeenCalled();
  });
});
