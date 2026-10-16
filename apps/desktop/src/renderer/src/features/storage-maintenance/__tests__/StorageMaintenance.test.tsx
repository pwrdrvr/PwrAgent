import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StorageMaintenanceCommand, StorageMaintenanceStatus } from "../../../../../shared/storage-maintenance";
import { STORAGE_MAINTENANCE_AUTO_CLOSE_MS, StorageMaintenance, type StorageMaintenanceBridge } from "../StorageMaintenance";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const base: StorageMaintenanceStatus = { phase: "cleanup", historyEnabled: true, beforeBytes: 200 * 1024 * 1024, completedThreads: 1, eligibleThreads: 4 };

async function renderWindow(initial: StorageMaintenanceStatus = base) {
  vi.useFakeTimers();
  let listener: ((status: StorageMaintenanceStatus) => void) | undefined;
  const command = vi.fn(async (_command: StorageMaintenanceCommand) => initial);
  const api: StorageMaintenanceBridge = { command, subscribe: (next) => { listener = next; return () => {}; } };
  const view = render(<StorageMaintenance api={api} />);
  // Settle the initial status read so it cannot land after a later publish.
  await act(async () => {});
  const publish = (patch: Partial<StorageMaintenanceStatus>) => act(() => listener!({ ...initial, ...patch }));
  const dismissals = () => command.mock.calls.filter(([value]) => value.action === "dismiss").length;
  const root = view.container.firstElementChild as HTMLElement;
  return { command, publish, dismissals, root, timer: () => root.querySelector(".storage-maintenance__timer") };
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it("counts down only once the job is over, then closes the window", async () => {
  const { publish, dismissals, timer } = await renderWindow();
  publish({});
  advance(STORAGE_MAINTENANCE_AUTO_CLOSE_MS * 3);
  expect(dismissals()).toBe(0);
  expect(timer()).toBeNull();

  publish({ phase: "error", message: "Archived thread status could not be verified." });
  expect(timer()).not.toBeNull();
  advance(STORAGE_MAINTENANCE_AUTO_CLOSE_MS - 1);
  expect(dismissals()).toBe(0);
  advance(1);
  expect(dismissals()).toBe(1);
});

it("pauses while the pointer is over the window and resumes from what was left", async () => {
  const { publish, dismissals, root, timer, command } = await renderWindow();
  publish({ phase: "complete", afterBytes: 100 * 1024 * 1024 });
  advance(2_000);
  fireEvent.mouseEnter(root);
  expect(command).toHaveBeenCalledWith({ action: "hold" });
  expect(timer()).toHaveAttribute("data-paused", "true");
  advance(60_000);
  expect(dismissals()).toBe(0);

  fireEvent.mouseLeave(root);
  expect(timer()).not.toHaveAttribute("data-paused");
  // The bar resumed where it froze, so the close must not restart from full.
  advance(STORAGE_MAINTENANCE_AUTO_CLOSE_MS - 2_000 - 1);
  expect(dismissals()).toBe(0);
  advance(1);
  expect(dismissals()).toBe(1);
});

it("does not close under a pointer that was already there when the job ended", async () => {
  const { publish, dismissals, root } = await renderWindow();
  fireEvent.mouseEnter(root);
  publish({ phase: "complete" });
  advance(60_000);
  expect(dismissals()).toBe(0);
  fireEvent.mouseLeave(root);
  advance(STORAGE_MAINTENANCE_AUTO_CLOSE_MS);
  expect(dismissals()).toBe(1);
});

// jsdom matches :focus-visible on the first Tab of a run only, so the
// keyboard case stubs the match that Chromium makes for real.
function asKeyboardFocus(element: HTMLElement) {
  const matches = element.matches.bind(element);
  vi.spyOn(element, "matches").mockImplementation((selector: string) => selector === ":focus-visible" || matches(selector));
}

it("pauses while keyboard focus is inside and resumes when it leaves", async () => {
  const { publish, dismissals } = await renderWindow();
  publish({ phase: "complete" });
  const checkbox = screen.getByRole("checkbox");
  asKeyboardFocus(checkbox);
  act(() => checkbox.focus());
  advance(60_000);
  expect(dismissals()).toBe(0);
  act(() => checkbox.blur());
  advance(STORAGE_MAINTENANCE_AUTO_CLOSE_MS);
  expect(dismissals()).toBe(1);
});

it("keeps a keyboard-focused control paused when Stop becomes Close", async () => {
  const { publish, dismissals } = await renderWindow();
  publish({});
  const stop = screen.getByRole("button", { name: "Stop" });
  asKeyboardFocus(stop);
  act(() => stop.focus());
  publish({ phase: "cancelled", message: "Stopped." });
  advance(60_000);
  expect(dismissals()).toBe(0);
});

it("counts down after a clicked Stop, whose focus stays on Close", async () => {
  const { publish, dismissals } = await renderWindow();
  publish({});
  const stop = screen.getByRole("button", { name: "Stop" });
  act(() => stop.focus());
  publish({ phase: "cancelled", message: "Stopped." });
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  advance(STORAGE_MAINTENANCE_AUTO_CLOSE_MS);
  expect(dismissals()).toBe(1);
});
