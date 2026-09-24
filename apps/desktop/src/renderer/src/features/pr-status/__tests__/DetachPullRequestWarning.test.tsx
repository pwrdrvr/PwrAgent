import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { DetachPullRequestWarning } from "../DetachPullRequestWarning";

const pr: PrSummary = {
  provider: "github.com",
  number: 412,
  org: "example-org",
  repo: "sample-app",
  state: "passing",
  checkState: "passing",
  lifecycleState: "open",
  reviewState: "ready_for_review",
  mergeState: "mergeable",
  url: "https://github.com/example-org/sample-app/pull/412",
};

function Harness(props: { onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Detach example-org/sample-app#412 from thread
      </button>
      {open ? (
        <DetachPullRequestWarning
          pr={pr}
          onCancel={() => {
            props.onCancel?.();
            setOpen(false);
          }}
          onConfirm={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("DetachPullRequestWarning focus", () => {
  it("opens on Cancel, keeps Tab inside, and returns focus on Escape", () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    const opener = screen.getByRole("button", {
      name: "Detach example-org/sample-app#412 from thread",
    });
    act(() => opener.focus());
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Detach pull request?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const detach = within(dialog).getByRole("button", { name: "Detach PR" });
    const checkbox = within(dialog).getByRole("checkbox");
    // The destructive action is never where focus starts.
    expect(cancel).toHaveFocus();

    act(() => detach.focus());
    fireEvent.keyDown(detach, { key: "Tab" });
    expect(checkbox).toHaveFocus();
    fireEvent.keyDown(checkbox, { key: "Tab", shiftKey: true });
    expect(detach).toHaveFocus();

    fireEvent.keyDown(detach, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});
