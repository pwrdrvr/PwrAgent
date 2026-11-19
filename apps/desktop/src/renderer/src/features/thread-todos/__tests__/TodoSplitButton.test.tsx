import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TodoSplitButton } from "../TodoSplitButton";

afterEach(cleanup);

it("floats its menu on the body, outside the rail's scroller and sticky headings", () => {
  const onSelect = vi.fn();
  render(
    <div className="thread-todos-panel__body" style={{ overflowY: "auto", height: 40 }}>
      <h4 className="thread-todos-panel__group-title">Next group</h4>
      <TodoSplitButton
        label="Start thread"
        menuLabel="Start options"
        onClick={vi.fn()}
        entries={[{ kind: "item", id: "here", label: "Do it here", onSelect }]}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start options" }));
  const menu = screen.getByRole("menu", { name: "Start options" });
  // Inside the scroller, a later sticky heading paints over the menu and the
  // scroller clips it.
  expect(menu.parentElement).toBe(document.body);
  expect(menu.closest(".thread-todos-panel__body")).toBeNull();
  // Placed before it takes focus, so the arrows start on its first row.
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Do it here" }));

  // A press in the floating menu is not a press outside the pill.
  fireEvent.pointerDown(menu);
  expect(screen.getByRole("menu", { name: "Start options" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Do it here" }));
  expect(onSelect).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Start options" }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});
