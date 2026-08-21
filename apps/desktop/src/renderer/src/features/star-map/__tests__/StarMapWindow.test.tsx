import { fireEvent, render, screen } from "@testing-library/react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { beforeEach, expect, it, vi } from "vitest";
import { StarMapWindow } from "../StarMapWindow";

const testState = vi.hoisted(() => ({
  markThreadsSeen: vi.fn(),
  remoteThread: {
    id: "thread-remote",
    title: "Remote work",
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 42,
    federation: {
      instanceLabel: "Studio Mac",
      ref: {
        backend: "codex",
        threadId: "thread-remote",
        target: { scope: "remote", instanceId: "pwr_peer" },
      },
    },
  },
}));

vi.mock("../../../lib/desktop-api", () => ({
  getDesktopApi: () => ({ platform: "linux" }),
  useDesktopApi: () => ({ markThreadSeen: vi.fn() }),
}));

vi.mock("../../../lib/useThreadNavigation", () => ({
  useThreadNavigation: () => ({
    markThreadsSeen: testState.markThreadsSeen,
    refresh: vi.fn(),
    threads: [],
  }),
}));

vi.mock("../../../lib/useThreadSessionState", () => ({
  useThreadSessionState: () => ({
    approvalRequestThreadKeys: {},
    inputRequestThreadKeys: {},
    thinkingThreadKeys: {},
  }),
}));

vi.mock("../../composer/useComposerDraftStore", () => ({
  useComposerDraftStore: () => ({}),
}));

vi.mock("../../composer/useDurableComposerDraftStore", () => ({
  useDurableComposerDraftStore: () => ({}),
}));

vi.mock("../../../lib/useThreadDraftIndicators", () => ({
  useThreadDraftIndicators: () => ({}),
}));

vi.mock("../../settings/useDesktopSettings", () => ({
  useDesktopSettings: () => ({ snapshot: undefined }),
}));

vi.mock("../StarMapScreen", () => ({
  StarMapScreen: (props: {
    onUserRepliedToThread?: (thread: NavigationThreadSummary) => void;
  }) => (
    <button
      type="button"
      onClick={() => props.onUserRepliedToThread?.(
        testState.remoteThread as NavigationThreadSummary,
      )}
    >
      Report accepted reply
    </button>
  ),
}));

beforeEach(() => {
  testState.markThreadsSeen.mockReset();
});

it("routes an accepted remote reply through navigation seen state", () => {
  render(<StarMapWindow />);

  fireEvent.click(screen.getByRole("button", { name: "Report accepted reply" }));

  expect(testState.markThreadsSeen).toHaveBeenCalledWith([
    testState.remoteThread,
  ]);
});
