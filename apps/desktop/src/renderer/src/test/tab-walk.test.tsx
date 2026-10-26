import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { documentTabStops, pressTab, walkTab } from "./tab-walk";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shares ancestor reads within a scan and observes visibility on the next Tab", () => {
  render(<div><button>First</button><button>Second</button></div>);
  const first = screen.getByRole("button", { name: "First" });
  const second = screen.getByRole("button", { name: "Second" });
  const readStyle = vi.spyOn(window, "getComputedStyle");

  expect(documentTabStops()).toEqual([first, second]);
  expect(readStyle.mock.calls.filter(([el]) => el === document.body)).toHaveLength(1);

  first.focus();
  second.style.display = "none";
  pressTab();
  expect(first).toHaveFocus();

  second.style.display = "";
  pressTab();
  expect(second).toHaveFocus();

  // A newly hidden origin still gives the browser its position in the
  // document. Only the destination needs a visibility check.
  second.style.display = "none";
  pressTab();
  expect(first).toHaveFocus();
});

it("wraps in both directions and starts from a negative-tabindex container", () => {
  render(<>
    <button>First</button>
    <div data-testid="container" tabIndex={-1}>
      <button disabled>Disabled</button>
      <button>Last</button>
    </div>
  </>);
  const first = screen.getByRole("button", { name: "First" });
  const last = screen.getByRole("button", { name: "Last" });
  const container = screen.getByTestId("container");

  first.focus();
  pressTab();
  expect(last).toHaveFocus();
  pressTab();
  expect(first).toHaveFocus();
  pressTab({ shift: true });
  expect(last).toHaveFocus();

  container.focus();
  pressTab({ shift: true });
  expect(first).toHaveFocus();
  container.focus();
  pressTab();
  expect(last).toHaveFocus();
});

it("invalidates visibility during a synchronous walk when an ancestor changes", () => {
  render(<>
    <div data-testid="first-parent"><button>First</button></div>
    <button>Second</button>
  </>);
  const first = screen.getByRole("button", { name: "First" });
  const parent = screen.getByTestId("first-parent");
  first.focus();
  const focusFirst = vi.spyOn(first, "focus").mockImplementation(() => {});
  let steps = 0;
  const changeVisibility = () => {
    steps += 1;
    if (steps === 2) parent.style.visibility = "hidden";
    if (steps === 3) parent.style.visibility = "";
  };
  document.addEventListener("keydown", changeVisibility);
  try {
    walkTab(3);
    // Step 2 skips the hidden ancestor; only step 3 may return to First.
    expect(focusFirst).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener("keydown", changeVisibility);
  }
});
