import { act } from "@testing-library/react";
import { vi } from "vitest";

export async function settleFakeTimers(milliseconds: number): Promise<void> {
  await act(async () => {
    // Finish the clock operation before yielding to real runner tasks. An
    // interrupted tickAsync keeps its act scope alive after teardown restores
    // real timers, so later tests render into that abandoned scope. Async act
    // still drains the promises and React updates started by these timers.
    vi.advanceTimersByTime(milliseconds);
  });
}
