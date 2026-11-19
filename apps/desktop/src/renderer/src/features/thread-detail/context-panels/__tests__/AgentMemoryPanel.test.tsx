// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentMemoryArgs, AgentMemoryResult } from "@pwragent/shared";
import { afterEach, expect, it, vi } from "vitest";
import { AgentMemoryPanel } from "../AgentMemoryPanel";

afterEach(cleanup);

it("refreshes owner notes on reload and reopen while keeping the draft and shared picker guards", async () => {
  let notes = ["initial-note"];
  const access = vi.fn(async (operation: AgentMemoryArgs): Promise<AgentMemoryResult> => {
    if (operation.action === "list") return { noteIds: notes };
    return { content: "Saved index", revision: "revision", exists: true };
  });
  render(<AgentMemoryPanel access={access} canEdit />);
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  const index = await screen.findByRole("textbox", { name: "Index" });
  const picker = screen.getByRole("combobox", { name: "File" }) as HTMLButtonElement;
  expect(picker.tagName).toBe("BUTTON");
  await waitFor(() => expect(picker.disabled).toBe(false));
  notes = ["reloaded-note"];
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(picker.disabled).toBe(false));
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "reloaded-note" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "initial-note" })).toBeNull();
  fireEvent.keyDown(picker, { key: "Escape" });
  fireEvent.change(index, { target: { value: "Operator draft" } });
  expect(picker.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close memory" }));
  notes = ["reopened-note"];
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  expect((index as HTMLTextAreaElement).value).toBe("Operator draft");
  await waitFor(() => expect(access.mock.calls.filter(([op]) => op.action === "list")).toHaveLength(3));
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
  await waitFor(() => expect(picker.disabled).toBe(false));
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "reopened-note" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "reloaded-note" })).toBeNull();
});
