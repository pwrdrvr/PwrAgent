import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse, AppServerThreadActivityEntry, ThreadToolAccounting } from "@pwragent/shared";
import { TranscriptActivity } from "../TranscriptActivity";
import { ToolCallsPanel } from "../context-panels/ToolCallsPanel";

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

it.each([false, true])("loads deferred command bodies from Tool Calls only on expansion (retry=%s)", async (retry) => {
  const response = full();
  const entry = response.replay.entries[0] as AppServerThreadActivityEntry;
  entry.details[0].command!.output = "Complete build output\n".repeat(200);
  const readThread = vi.fn(async () => response);
  if (retry) readThread.mockRejectedValueOnce(new Error("Owner is unavailable"));
  const onRequestInvocationDetails = vi.fn();
  const accounting: ThreadToolAccounting = {
    alerts: [],
    invocations: [{
      backend: "codex", threadId: "thread", turnId: "turn", itemId: "command", invocationId: "invocation",
      toolName: "exec", category: "build-test", status: "completed", normalizedCommand: "pnpm build",
      observedAt: 1, updatedAt: 1, outputChars: 4000, outputLines: 200, estimatedOutputTokens: 1000,
      debugLines: 0, infoLines: 200, warningLines: 0, errorLines: 0, noisy: false, outputTruncated: false,
    }],
    summaries: [{
      toolName: "exec", category: "build-test", invocationCount: 1, noisyInvocationCount: 0, lastObservedAt: 1,
      outputChars: 4000, outputLines: 200, estimatedOutputTokens: 1000,
      debugLines: 0, infoLines: 200, warningLines: 0, errorLines: 0,
    }],
  };
  render(<ToolCallsPanel entries={[activity()]} toolAccounting={accounting} desktopApi={{ readThread }}
    onRequestInvocationDetails={onRequestInvocationDetails} threadLinkSource={{ backend: "codex", instanceId: "remote-owner" }} />);
  expect(readThread).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(readThread).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("Loading captured output…")).toBeVisible();
  if (retry) {
    expect(await screen.findByRole("alert")).toHaveTextContent("Owner is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  }
  expect(await screen.findByText(/Complete build output/)).toBeVisible();
  expect(screen.getByText("$ pnpm build")).toBeVisible();
  expect(readThread).toHaveBeenCalledTimes(retry ? 2 : 1);
  expect(readThread).toHaveBeenLastCalledWith({
    backend: "codex", threadId: "thread", federationTarget: { scope: "remote", instanceId: "remote-owner" },
    display: { resource: "activity", activity: { turnId: "turn", entryId: "activity-command" } }, viewOnly: true,
  });
  // The skeleton is already in history; expanding it must not page older turns.
  expect(onRequestInvocationDetails).not.toHaveBeenCalled();
});

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
