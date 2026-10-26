import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { documentTabStops, pressTab } from "./tab-walk";

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
