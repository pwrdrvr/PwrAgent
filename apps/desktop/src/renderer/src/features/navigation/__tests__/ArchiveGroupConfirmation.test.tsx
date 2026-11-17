import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ArchiveGroupConfirmation, useArchiveGroupConfirmation } from "../ArchiveGroupConfirmation";
import type { NavigationArchiveMember } from "../../../lib/navigation-archive-group";
import { tabEscapes } from "../../../test/tab-walk";

const members: readonly NavigationArchiveMember[] = Object.freeze([
  { id: "same", source: "claude", title: "Peer child", federation: { instanceLabel: "Remote Mac",
    ref: { backend: "claude", threadId: "same", target: { scope: "remote", instanceId: "peer" } } } },
  { id: "same", source: "codex", title: "Local parent" },
]);

it("shows the exact count, titles and machines; traps focus and confirms that snapshot", async () => {
  let confirmed: Promise<boolean> | undefined;
  const done = vi.fn();
  function Harness() {
    const controller = useArchiveGroupConfirmation();
    return <><button onClick={() => { confirmed = controller.confirm(members); void confirmed.then(done); }}>Open archive</button>
      <ArchiveGroupConfirmation controller={controller} /></>;
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open archive" });
  act(() => { opener.focus(); fireEvent.click(opener); });
  const dialog = screen.getByRole("dialog", { name: "Archive 2 Threads?" });
  expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Peer childRemote Mac", "Local parentThis machine",
  ]);
  expect(document.activeElement).toBe(dialog);
  expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 Threads" }));
  await expect(confirmed).resolves.toBe(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
});

it("Escape cancels the pending snapshot", async () => {
  const controller = renderHook(() => useArchiveGroupConfirmation());
  let result!: Promise<boolean>;
  act(() => { result = controller.result.current.confirm(members); });
  const ui = render(<ArchiveGroupConfirmation controller={controller.result.current} />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await expect(result).resolves.toBe(false);
  ui.unmount();
  controller.unmount();
});

it("cannot replace a pending confirmation and cancels it on unmount", async () => {
  const controller = renderHook(() => useArchiveGroupConfirmation());
  let pending!: Promise<boolean>;
  act(() => { pending = controller.result.current.confirm(members); });
  await expect(controller.result.current.confirm([])).resolves.toBe(false);
  expect(controller.result.current.members).toBe(members);
  controller.unmount();
  await expect(pending).resolves.toBe(false);
});
