import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AutomationSchedulingStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useAutomationSchedulingStatus } from "../useAutomationSchedulingStatus";

function fakeApi() {
  let push: ((status: AutomationSchedulingStatus) => void) | undefined;
  let resolveRead: ((status: AutomationSchedulingStatus) => void) | undefined;
  const api = {
    readAutomationSchedulingStatus: () => new Promise<AutomationSchedulingStatus>((resolve) => {
      resolveRead = resolve;
    }),
    onAutomationSchedulingStatus: (callback: (status: AutomationSchedulingStatus) => void) => {
      push = callback;
      return () => {
        push = undefined;
      };
    },
  } as unknown as DesktopApi;
  return { api, push: (status: AutomationSchedulingStatus) => push?.(status), resolveRead: (status: AutomationSchedulingStatus) => resolveRead?.(status) };
}

const elsewhere: AutomationSchedulingStatus = { state: "elsewhere", holder: { instanceId: "other", processId: 7 } };

describe("useAutomationSchedulingStatus", () => {
  it("shows the initial read", async () => {
    const { api, resolveRead } = fakeApi();
    const { result } = renderHook(() => useAutomationSchedulingStatus(api));
    await act(async () => resolveRead(elsewhere));
    expect(result.current).toEqual(elsewhere);
  });

  it("keeps a pushed change over an initial read that lands later", async () => {
    const { api, push, resolveRead } = fakeApi();
    const { result } = renderHook(() => useAutomationSchedulingStatus(api));
    // The read was answered before the other instance quit, but arrives after.
    act(() => push({ state: "active" }));
    await act(async () => resolveRead(elsewhere));
    expect(result.current).toEqual({ state: "active" });
  });
});
