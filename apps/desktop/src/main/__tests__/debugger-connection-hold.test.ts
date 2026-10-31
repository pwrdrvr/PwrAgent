import { describe, expect, it, vi } from "vitest";
import { holdDebuggerConnection, reclaimDeferredDebuggerDetach, requestDebuggerDetach } from "../diagnostics/debugger-connection-hold";

describe("native trace debugger hold", () => {
  it("allows the V8 owner to resume after a profile save without detaching at native release", () => {
    const d = { isAttached: () => true, detach: vi.fn() };
    const release = holdDebuggerConnection(d);
    requestDebuggerDetach(d);
    expect(d.detach).not.toHaveBeenCalled();
    expect(reclaimDeferredDebuggerDetach(d)).toBe(true);
    release();
    expect(d.detach).not.toHaveBeenCalled();
    requestDebuggerDetach(d);
    expect(d.detach).toHaveBeenCalledOnce();
  });
  it("does not grant ownership of another attached debugger", () => {
    const d = { isAttached: () => true, detach: vi.fn() };
    const release = holdDebuggerConnection(d);
    expect(reclaimDeferredDebuggerDetach(d)).toBe(false);
    release();
    release();
    expect(d.detach).not.toHaveBeenCalled();
  });
});
