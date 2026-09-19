import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { navigationOwnerApiFixture } from "../test/navigation-owner-api-fixture";
import type { DesktopApi } from "../lib/desktop-api";
import { App } from "../App";
import type { Composer } from "../features/composer/Composer";

const probe = vi.hoisted(() => ({
  renders: 0,
  props: undefined as ComponentProps<typeof Composer> | undefined,
}));
// Exercise the real App -> ThreadView prop path, preserving Composer's shallow
// memo boundary without loading its editor. Count renders, not elapsed time.
vi.mock("../features/composer/Composer", async () => {
  const { memo } = await import("react");
  return {
    Composer: memo((props: ComponentProps<typeof Composer>) => {
      probe.renders++;
      probe.props = props;
      return <div data-testid="composer-probe" />;
    }),
  };
});
await import("../features/thread-detail/ThreadView");

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "pwragent");
  localStorage.clear();
  probe.renders = 0;
  probe.props = undefined;
});

async function setup() {
  const thread: NavigationThreadSummary = {
    id: "thread-a",
    source: "codex",
    title: "Render fixture",
    titleSource: "explicit",
    executionMode: "default",
    gitBranch: "main",
    linkedDirectories: [],
    inbox: { inInbox: true },
  };
  const secondThread = {
    ...thread,
    id: "thread-b",
    title: "Second fixture",
    gitBranch: "feature",
  };
  const checkThreadBranchDrift = vi.fn(async (
    request: Parameters<NonNullable<DesktopApi["checkThreadBranchDrift"]>>[0],
  ) => ({
    ...request,
    drifted: false,
    observedBranch: request.expectedBranch,
    checkedAt: 1,
  }));
  const setThreadExecutionMode = vi.fn(async (
    request: Parameters<NonNullable<DesktopApi["setThreadExecutionMode"]>>[0],
  ) => ({ ...request }));
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: navigationOwnerApiFixture({
      platform: "darwin",
      readPopulation: async () => ({
        backend: "all",
        fetchedAt: 1,
        unchanged: false,
        launchpadDefaults: { backend: "codex", executionMode: "default" },
        inboxThreadKeys: ["codex:thread-a", "codex:thread-b"],
        threads: [thread, secondThread],
        directories: [],
      }),
      listBackends: async () => ({ fetchedAt: 1, backends: [] }),
      markThreadSeen: async ({ backend, threadId }) => ({ backend, threadId, seenAt: 1 }),
      checkThreadBranchDrift,
      setThreadExecutionMode,
      readThread: async (request) => ({
        backend: "codex",
        fetchedAt: 1,
        threadId: request.threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      }),
      onAgentEvent: () => () => undefined,
      onWindowFocus: () => () => undefined,
    }),
  });
  const view = render(<App />);
  await screen.findByRole("heading", { name: "Render fixture" });
  await screen.findByTestId("composer-probe");
  await waitFor(() => expect(probe.props?.thread?.id).toBe(thread.id));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { view, checkThreadBranchDrift, setThreadExecutionMode };
}

it("does not rerender the memoized composer on unrelated shell updates", async () => {
  const { view } = await setup();
  const before = probe.renders;
  for (let i = 0; i < 4; i++) {
    await act(async () => { view.rerender(<App />); });
  }
  expect(probe.renders - before).toBe(0);
});

it("uses the newly selected thread in retained callbacks and respects abort", async () => {
  const { checkThreadBranchDrift, setThreadExecutionMode } = await setup();
  const beforeStart = probe.props!.onBeforeStartTurn!;
  const beforeSend = probe.props!.onBeforeSendTurn!;
  const setExecutionMode = probe.props!.onSetExecutionMode!;
  fireEvent.click(screen.getByRole("button", { name: "Second fixture" }));
  await waitFor(() => expect(probe.props?.thread?.id).toBe("thread-b"));
  expect(probe.props!.onBeforeStartTurn).toBe(beforeStart);
  expect(probe.props!.onBeforeSendTurn).toBe(beforeSend);
  expect(probe.props!.onSetExecutionMode).toBe(setExecutionMode);
  checkThreadBranchDrift.mockClear();
  await act(async () => { expect(await beforeStart()).toBe(true); });
  expect(checkThreadBranchDrift).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thread-b", expectedBranch: "feature",
  }));
  const controller = new AbortController();
  controller.abort();
  await act(async () => { expect(await beforeStart(controller.signal)).toBe(false); });
  await act(async () => { await setExecutionMode("default"); });
  expect(setThreadExecutionMode).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thread-b", executionMode: "default",
  }));
});
