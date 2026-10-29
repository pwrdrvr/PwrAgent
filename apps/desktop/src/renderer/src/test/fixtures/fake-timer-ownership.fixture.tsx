import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { setImmediate } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { settleFakeTimers } from "../settle-fake-timers";

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  cleanup();
});

function Clock() {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTicks((value) => value + 1), 1);
    return () => clearInterval(timer);
  }, []);
  return <output>{ticks}</output>;
}

it("interrupts a busy fake clock", async () => {
  vi.useFakeTimers();
  render(<Clock />);
  const interrupted = new Promise<never>((_resolve, reject) => {
    setTimeout(() => setImmediate(() => reject(new Error("Simulated test interruption"))), 1);
  });
  // A runner timeout also ends the test without cancelling a pending clock
  // advancement. Interrupt at a known real-task boundary instead of relying
  // on wall-clock speed or machine load to reproduce that ownership race.
  await Promise.race([settleFakeTimers(2_000), interrupted]);
});

it("renders independently after the fake-clock test", () => {
  render(<button>Independent render</button>);
  expect(screen.getByRole("button", { name: "Independent render" }).textContent).toBe("Independent render");
});
