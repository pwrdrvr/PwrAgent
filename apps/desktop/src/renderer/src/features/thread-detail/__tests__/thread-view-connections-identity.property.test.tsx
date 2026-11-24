import "@testing-library/jest-dom/vitest";
import { act, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type {
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import { ThreadView, type ThreadViewProps } from "../ThreadView";

const directory = {
  key: "directory:/repo",
  kind: "directory",
  label: "Repo",
  path: "/repo",
  threadKeys: [],
  needsAttentionCount: 0,
} satisfies NavigationDirectorySummary;
const launchpad = {
  backend: "codex",
  createdAt: 1_000,
  directoryKey: directory.key,
  directoryKind: directory.kind,
  directoryLabel: directory.label,
  directoryPath: directory.path,
  executionMode: "default",
  prompt: "",
  updatedAt: 1_000,
  workMode: "local",
} satisfies NavigationLaunchpadDraft;

type LayoutChange = { sidebarHidden: boolean; contextRailPinned: boolean };

function Launchpad(props: { desktopApi: DesktopApi } & LayoutChange) {
  const terminals = useIntegratedTerminals(props.desktopApi);
  const view: ThreadViewProps = {
    ...props,
    terminals,
    addOptimisticUserMessage: () => "optimistic-1",
    backends: [],
    clearPendingRequest: () => undefined,
    composerDisabled: false,
    launchpadConnectionsDock: "launchpad",
    loading: false,
    loadingMore: false,
    messageCount: 0,
    selectedDirectory: directory,
    selectedLaunchpad: launchpad,
    skills: [],
    transcriptEntries: [],
    onLoadOlder: async () => undefined,
    removeOptimisticMessage: () => undefined,
  };
  return <ThreadView {...view} />;
}

const layoutChanges = fc.array(fc.record({ sidebarHidden: fc.boolean(), contextRailPinned: fc.boolean() }), {
  minLength: 1, maxLength: 5, size: "max",
});
type ReadStatus = NonNullable<DesktopApi["readPwrSnapConnectionStatus"]>;
const availableStatus = {
  connectionId: "pwrsnap", displayName: "PwrSnap", availability: "running", configured: false,
} satisfies Awaited<ReturnType<ReadStatus>>;

function mockStatus(ready: ReturnType<ReadStatus> = Promise.resolve(availableStatus)) {
  return { ready, read: vi.fn<ReadStatus>(() => ready) };
}

async function checkLayoutHistory(signal: AbortSignal, changes: LayoutChange[], status = mockStatus()) {
  signal.throwIfAborted();
  const desktopApi: DesktopApi = {
    listMcpConnections: async () => ({ connections: [] }),
    readPwrSnapConnectionStatus: status.read,
  };
  const view = render(<Launchpad desktopApi={desktopApi} sidebarHidden={false} contextRailPinned />);
  const { promise: aborted, resolve: resolveAbort } = Promise.withResolvers<void>();
  const stopWaiting = () => resolveAbort();
  signal.addEventListener("abort", stopWaiting, { once: true });
  try {
    // Let act flush on abort before throwing cancellation to the caller.
    await act(async () => {
      if (!signal.aborted) await Promise.race([status.ready, aborted]);
    });
    signal.throwIfAborted();
    const tileButton = () => within(view.container).getByRole("button", { name: "Update PwrSnap" });
    const button = tileButton();
    for (const change of changes) {
      view.rerender(<Launchpad desktopApi={desktopApi} {...change} />);
      expect(tileButton()).toBe(button);
      expect(status.read).toHaveBeenCalledTimes(1);
    }
  } finally {
    signal.removeEventListener("abort", stopWaiting);
    view.unmount();
    view.container.remove();
  }
}

// A parent update must keep the connection tiles mounted. A locally declared
// React component would replace the DOM and reread status on every update.
it("retains connection tile identity through window layout changes", async ({ onTestFinished, signal }) => {
  const work = fc.assert(fc.asyncProperty(layoutChanges, (changes) => checkLayoutHistory(signal, changes)), { numRuns: 25 });
  // A Vitest timeout aborts the context and stops awaiting the property.
  // Join the cancelled case before the runner destroys editors and jsdom.
  onTestFinished(() => work.catch(() => undefined));
  await work;
});

it("unmounts the layout history on abort while the connection status is pending", async ({ onTestFinished }) => {
  const controller = new AbortController();
  const reason = new Error("layout history ended before connection status was ready");
  const pending = Promise.withResolvers<Awaited<ReturnType<ReadStatus>>>();
  const status = mockStatus(pending.promise);
  const changes = [{ sidebarHidden: true, contextRailPinned: false }];

  const work = checkLayoutHistory(controller.signal, changes, status);
  onTestFinished(async () => {
    pending.resolve(availableStatus);
    await work.catch(() => undefined);
  });
  const input = screen.getByLabelText("New thread");
  expect(status.read).toHaveBeenCalledTimes(1);
  controller.abort(reason);

  await expect(work).rejects.toBe(reason);
  expect(input).not.toBeInTheDocument();
  await expect(checkLayoutHistory(controller.signal, changes, status)).rejects.toBe(reason);
  expect(status.read).toHaveBeenCalledTimes(1);
});
