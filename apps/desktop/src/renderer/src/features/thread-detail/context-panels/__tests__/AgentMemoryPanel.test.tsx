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
  fireEvent.click(screen.getByRole("button", { name: "Hide memory" }));
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

it("explains a rejected note name and a view-only store instead of failing silently", async () => {
  const access = vi.fn(async (operation: AgentMemoryArgs): Promise<AgentMemoryResult> => {
    if (operation.action === "list") return { noteIds: [] };
    return { content: "Saved index", revision: "revision", exists: true };
  });
  const view = render(<AgentMemoryPanel access={access} canEdit />);
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  await screen.findByRole("textbox", { name: "Index" });
  await waitFor(() => expect((screen.getByRole("button", { name: "New note" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "New note" }));
  const name = screen.getByRole("textbox", { name: "Note name" });
  const open = screen.getByRole("button", { name: "Open note" }) as HTMLButtonElement;
  for (const [value, valid] of [["Release checks", false], ["-release", false], ["release-checks", true], ["", false]] as const) {
    fireEvent.change(name, { target: { value } });
    expect(open.disabled).toBe(!valid);
    expect(name.getAttribute("aria-invalid")).toBe(String(value !== "" && !valid));
    expect(name.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(name.getAttribute("aria-describedby") ?? "")?.textContent)
      .toBe("Lowercase letters, numbers, and hyphens.");
  }
  view.unmount();

  render(<AgentMemoryPanel access={access} canEdit={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  const index = await screen.findByRole("textbox", { name: "Index" }) as HTMLTextAreaElement;
  await waitFor(() => expect(index.readOnly).toBe(true));
  expect(screen.getByText("View only. Editing needs control of this thread on its machine.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});
