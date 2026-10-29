import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
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

it("settles a busy fake clock without leaving act in the next test", async () => {
  vi.useFakeTimers();
  render(<Clock />);
  await settleFakeTimers(2_000);
  expect(screen.getByRole("status").textContent).toBe("2000");
}, 100);

it("renders independently after the fake-clock test", () => {
  render(<button>Independent render</button>);
  expect(screen.getByRole("button", { name: "Independent render" }).textContent).toBe("Independent render");
});
