import { act } from "@testing-library/react";
import { vi } from "vitest";

export async function settleFakeTimers(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
