import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { PrSummary } from "@pwragent/shared";
import { afterEach, describe, expect, it } from "vitest";
import { DetachPullRequestWarning } from "../DetachPullRequestWarning";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";

afterEach(() => {
  cleanup();
});

const pr = {
  org: "acme",
  repo: "sprocket",
  number: 42,
} as PrSummary;

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Detach
      </button>
      {open ? (
        <DetachPullRequestWarning
          pr={pr}
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function open(): HTMLElement {
  render(<Host />);
  const opener = screen.getByRole("button", { name: "Detach" });
  opener.focus();
  act(() => opener.click());
  return screen.getByRole("dialog", { name: "Detach pull request?" });
}

describe("DetachPullRequestWarning, keyboard", () => {
  it("opens with focus on Cancel, the action that changes nothing", () => {
    open();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
  });

  it("keeps Tab inside the dialog", () => {
    const dialog = open();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  });

  it("cancels on Escape and returns focus to the opener", () => {
    open();
    pressEscape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Detach" }),
    );
  });
});
