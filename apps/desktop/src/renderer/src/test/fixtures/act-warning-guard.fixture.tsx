// These intentionally failing cases run only in the guard's nested Vitest run.
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

let update: () => void;
function Counter() {
  const [count, setCount] = useState(0);
  update = () => setCount((value) => value + 1);
  return <output>{count}</output>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("fails a real unwrapped React update while preserving console output", () => {
  const error = vi.spyOn(console, "error");
  render(<Counter />);
  update();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("not wrapped in act"), "Counter");
});

it("fails an asynchronous React update behind a silenced console spy", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<Counter />);
  await Promise.resolve().then(update);
  expect(error).toHaveBeenCalledOnce();
});

it("fails after restoreAllMocks", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.restoreAllMocks();
  render(<Counter />);
  update();
});

it("fails a warning from onTestFinished", () => {
  onTestFinished(async () => {
    await Promise.resolve();
    console.error("An update to %s inside a test was not wrapped in act(...).", "Finished");
  });
});

describe("teardown", () => {
  afterEach(async () => {
    await Promise.resolve();
    console.warn("An update to Teardown inside a test was not wrapped in act(...).");
  });
  it("fails a warning from afterEach", () => {});
});

let release: () => void;
it("attributes a late callback to its originating test", () => {
  const pending = new Promise<void>((resolve) => { release = resolve; });
  void pending.then(() => console.error("An update to LateOwner inside a test was not wrapped in act(...)."));
});

it("does not blame the test that releases another test's callback", async () => {
  release();
  await Promise.resolve();
});

describe("final async teardown", () => {
  let finish: () => void;
  let pending: Promise<void>;
  afterAll(async () => {
    finish();
    await pending;
  });
  it("fails the originating final test when its callback settles in afterAll", () => {
    pending = new Promise<void>((resolve) => { finish = resolve; }).then(() => {
      console.error("An update to FinalOwner inside a test was not wrapped in act(...).");
    });
  });
});

describe("suite teardown", () => {
  afterAll(() => console.error("A suspended resource finished loading inside a test, but the event was not wrapped in act(...)."));
  it("has a clean body", () => {});
});

it("passes clean act-wrapped synchronous and asynchronous updates", async () => {
  render(<Counter />);
  act(update);
  await act(async () => { await Promise.resolve().then(update); });
  expect(screen.getByRole("status").textContent).toBe("2");
});

it("preserves other console errors, warnings, arguments and spy assertions", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const detail = { reason: "expected fixture failure" };
  console.error("IPC failed: %o", detail);
  console.warn("ordinary warning", detail);
  expect(error).toHaveBeenCalledWith("IPC failed: %o", detail);
  expect(warn).toHaveBeenCalledWith("ordinary warning", detail);
});
