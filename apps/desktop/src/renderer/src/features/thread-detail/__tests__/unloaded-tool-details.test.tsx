import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse, AppServerThreadEntry, ThreadToolAccounting } from "@pwragent/shared";
import { ToolCallsPanel } from "../context-panels/ToolCallsPanel";
import { useToolInvocationDetails } from "../../../lib/useToolInvocationDetails";

afterEach(cleanup);

function accounting(): ThreadToolAccounting {
  return {
    alerts: [],
    invocations: [{
      backend: "codex", threadId: "thread", turnId: "old-turn", itemId: "middle", invocationId: "invocation",
      toolName: "exec", category: "build-test", status: "completed", normalizedCommand: "build",
      observedAt: 1000, updatedAt: 2000, outputChars: 100, outputLines: 1, estimatedOutputTokens: 25,
      debugLines: 0, infoLines: 1, warningLines: 0, errorLines: 0, noisy: false, outputTruncated: false,
    }],
    summaries: [{
      toolName: "exec", category: "build-test", invocationCount: 1, noisyInvocationCount: 0, lastObservedAt: 1000,
      outputChars: 100, outputLines: 1, estimatedOutputTokens: 25,
      debugLines: 0, infoLines: 1, warningLines: 0, errorLines: 0,
    }],
  };
}
function response(output = "Isolated output"): AppServerReadThreadResponse {
  return {
    backend: "codex", threadId: "thread", fetchedAt: 100,
    toolInvocationDetails: { turnId: "old-turn", itemId: "middle", details: [{
      id: "middle", kind: "command", label: "Ran build", command: { displayCommand: "build", output, exitCode: 0 },
    }] },
    replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
  };
}

it("loads an unloaded invocation on expansion, reuses its bodies and leaves transcript order, groups and times intact", async () => {
  let finish: (value: AppServerReadThreadResponse) => void = () => undefined;
  const readThread = vi.fn(() => new Promise<AppServerReadThreadResponse>((resolve) => { finish = resolve; }));
  const onRequestInvocationDetails = vi.fn();
  const onScrollToTurn = vi.fn();
  const entries: AppServerThreadEntry[] = [{ type: "activity", id: "recent-group", summary: "Recent commands",
    createdAt: 9999, status: "completed", turn: { id: "recent-turn", startedAt: 9000, completedAt: 10000 },
    itemIds: ["recent-a", "recent-b"], details: [],
  }];
  const before = structuredClone(entries);
  render(<ToolCallsPanel entries={entries} toolAccounting={accounting()} desktopApi={{ readThread }}
    onRequestInvocationDetails={onRequestInvocationDetails} onScrollToTurn={onScrollToTurn}
    threadLinkSource={{ backend: "codex", instanceId: "remote-owner" }} />);
  expect(readThread).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(readThread).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  await waitFor(() => expect(readThread).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Loading captured output…")).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Hide" })[1]);
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(readThread).toHaveBeenCalledTimes(1);
  await act(async () => finish(response()));
  expect(await screen.findByText("Isolated output")).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Hide" })[1]);
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(readThread).toHaveBeenCalledExactlyOnceWith({
    backend: "codex", threadId: "thread", viewOnly: true,
    federationTarget: { scope: "remote", instanceId: "remote-owner" },
    display: { resource: "activity", activity: { turnId: "old-turn", entryId: "activity-middle", invocationItemId: "middle" } },
  });
  expect(onRequestInvocationDetails).not.toHaveBeenCalled();
  expect(onScrollToTurn).not.toHaveBeenCalled();
  expect(entries).toEqual(before);
  // Explicit reveal still uses the full transcript-loading path.
  fireEvent.click(screen.getByRole("button", { name: /Scroll the transcript to this turn/ }));
  expect(onScrollToTurn).toHaveBeenCalledExactlyOnceWith("old-turn", 1000);
});

it("rejects late details from another owner and offers retry without transcript paging", async () => {
  let finish: (value: AppServerReadThreadResponse) => void = () => undefined;
  const readThread = vi.fn()
    .mockImplementationOnce(() => new Promise<AppServerReadThreadResponse>((resolve) => { finish = resolve; }))
    .mockRejectedValueOnce(new Error("Owner unavailable"))
    .mockResolvedValue(response("New owner output"));
  function Probe({ owner }: { owner: string }) {
    const details = useToolInvocationDetails({ invocation: accounting().invocations[0], enabled: true, desktopApi: { readThread }, instanceId: owner });
    return <>{details.error ? <p role="alert">{details.error}</p> : null}
      <span>{details.details?.[0].command?.output}</span><button onClick={() => void details.load()}>Retry</button></>;
  }
  const rendered = render(<Probe owner="old" />);
  await waitFor(() => expect(readThread).toHaveBeenCalledTimes(1));
  rendered.rerender(<Probe owner="new" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Owner unavailable");
  await act(async () => finish(response("Old owner output")));
  expect(screen.queryByText("Old owner output")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("New owner output")).toBeVisible();
  expect(readThread).toHaveBeenCalledTimes(3);
});

it("refreshes on invocation completion without reading on streamed accounting updates", async () => {
  const readThread = vi.fn().mockResolvedValueOnce(response("Running output")).mockResolvedValueOnce(response("Final output"));
  const invocation = { ...accounting().invocations[0], status: "in_progress" as const };
  function Probe({ completed, updatedAt }: { completed: boolean; updatedAt: number }) {
    const details = useToolInvocationDetails({
      invocation: { ...invocation, updatedAt, status: completed ? "completed" : "in_progress", completedAt: completed ? 3000 : undefined },
      enabled: true, desktopApi: { readThread },
    });
    return <span>{details.details?.[0].command?.output}</span>;
  }
  const rendered = render(<Probe completed={false} updatedAt={1000} />);
  expect(await screen.findByText("Running output")).toBeVisible();
  rendered.rerender(<Probe completed={false} updatedAt={2000} />);
  expect(readThread).toHaveBeenCalledTimes(1);
  rendered.rerender(<Probe completed updatedAt={3000} />);
  expect(await screen.findByText("Final output")).toBeVisible();
  expect(readThread).toHaveBeenCalledTimes(2);
});

it.each(["old-owner", "wrong-thread", "wrong-turn", "wrong-item"])("does not consume replay or mismatched detail responses (%s)", async (scenario) => {
  const returned = response();
  if (scenario === "old-owner") {
    returned.toolInvocationDetails = undefined;
    returned.replay.entries = [{ type: "activity", id: "activity-middle", summary: "Partial group", details: [] }];
  }
  if (scenario === "wrong-thread") returned.threadId = "other";
  if (scenario === "wrong-turn") returned.toolInvocationDetails!.turnId = "other";
  if (scenario === "wrong-item") returned.toolInvocationDetails!.itemId = "other";
  const readThread = vi.fn(async () => returned);
  function Probe() {
    const details = useToolInvocationDetails({ invocation: accounting().invocations[0], enabled: true, desktopApi: { readThread } });
    return <span>{details.error ?? details.details?.[0].command?.output}</span>;
  }
  render(<Probe />);
  expect(await screen.findByText(/Load the transcript/)).toBeVisible();
  expect(screen.queryByText("Isolated output")).not.toBeInTheDocument();
});
