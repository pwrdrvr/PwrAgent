import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse, AppServerThreadActivityEntry } from "@pwragent/shared";
import { TranscriptActivity } from "../TranscriptActivity";

afterEach(cleanup);

function activity(): AppServerThreadActivityEntry {
  return {
    type: "activity", id: "activity-command", summary: "Ran build", status: "completed",
    turn: { id: "turn", status: "completed" },
    details: [{ id: "command", kind: "command", label: "Ran build", command: { displayCommand: "" } }],
    detailsRef: { backend: "codex", threadId: "thread", turnId: "turn", entryId: "activity-command", revision: "revision" },
  };
}
function full(): AppServerReadThreadResponse {
  return {
    backend: "codex", threadId: "thread", fetchedAt: 100,
    replay: { entries: [{ ...activity(), detailsRef: undefined, details: [{
      id: "command", kind: "command", label: "Ran build", command: { displayCommand: "pnpm build", output: "Complete build output", exitCode: 0 },
    }] }], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
  };
}

it("fetches nothing while collapsed, shares repeated expansion reads and keeps loaded details when collapsed again", async () => {
  let finish: ((value: AppServerReadThreadResponse) => void) | undefined;
  const readThread = vi.fn(() => new Promise<AppServerReadThreadResponse>((resolve) => { finish = resolve; }));
  const copyText = vi.fn(async () => undefined);
  render(<TranscriptActivity entry={activity()} desktopApi={{ readThread, copyText }} threadLinkSource={{ backend: "codex", instanceId: "remote-owner" }} />);
  expect(readThread).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ran build" }));
  await waitFor(() => expect(readThread).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status")).toHaveTextContent("Loading activity details");
  fireEvent.click(screen.getByRole("button", { name: "Ran build" }));
  fireEvent.click(screen.getByRole("button", { name: "Ran build" }));
  await act(async () => finish?.(full()));
  expect(readThread).toHaveBeenCalledExactlyOnceWith({
    backend: "codex", threadId: "thread", federationTarget: { scope: "remote", instanceId: "remote-owner" },
    display: { resource: "activity", activity: { turnId: "turn", entryId: "activity-command" } }, viewOnly: true,
  });
  expect(screen.getByText("Complete build output")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Ran build" }));
  fireEvent.click(screen.getByRole("button", { name: "Ran build" }));
  expect(readThread).toHaveBeenCalledTimes(1);
});

it("copies the existing activity summary without fetching hidden details", async () => {
  const readThread = vi.fn(async () => full());
  const copyText = vi.fn(async () => undefined);
  render(<TranscriptActivity entry={activity()} desktopApi={{ readThread, copyText }} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy activity" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith("Ran build\nRan build"));
  expect(screen.getByRole("button", { name: "Ran build" })).toHaveAttribute("aria-expanded", "false");
  expect(readThread).not.toHaveBeenCalled();
});

it("offers an explicit retry on failure and ignores a late response from another owner", async () => {
  let finishOld: ((value: AppServerReadThreadResponse) => void) | undefined;
  const readThread = vi.fn()
    .mockImplementationOnce(() => new Promise<AppServerReadThreadResponse>((resolve) => { finishOld = resolve; }))
    .mockRejectedValueOnce(new Error("Owner is unavailable"))
    .mockResolvedValue(full());
  const rendered = render(<TranscriptActivity entry={activity()} expanded desktopApi={{ readThread }} threadLinkSource={{ backend: "codex", instanceId: "old" }} />);
  await waitFor(() => expect(readThread).toHaveBeenCalledTimes(1));
  rendered.rerender(<TranscriptActivity entry={activity()} expanded desktopApi={{ readThread }} threadLinkSource={{ backend: "codex", instanceId: "new" }} />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Owner is unavailable"));
  await act(async () => finishOld?.(full()));
  expect(screen.queryByText("Complete build output")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByText("Complete build output")).toBeVisible());
  expect(readThread).toHaveBeenCalledTimes(3);
});
