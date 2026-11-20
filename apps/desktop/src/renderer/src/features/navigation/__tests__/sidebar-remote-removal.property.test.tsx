import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { FixtureSidebar as Sidebar } from "../../../test/navigation-presentation-fixture";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";

type RowKind = "local" | "connected" | "disconnected" | "derived";

function row(kind: RowKind, id: string): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: `Contrived ${id}`,
    titleSource: "explicit",
    linkedDirectories: [],
    inbox: { inInbox: false },
    ...(kind === "local" ? {} : {
      federation: {
        ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: "peer" } },
        instanceLabel: "Fixture peer",
        peerStatus: kind === "disconnected" ? "disconnected" : "connected",
        capabilities: [],
        derivedFromMountedParent: kind === "derived",
      },
    }),
    ...(kind === "derived" ? { parentThreadId: "mounted-root", parentThreadBackend: "codex" } : {}),
  };
}

function openSelection(kinds: RowKind[], options: { remoteWindow?: boolean; canRemove?: boolean } = {}) {
  if (options.remoteWindow) {
    Object.defineProperty(window, "__pwragentFederationTarget", {
      configurable: true,
      value: { scope: "remote", instanceId: "peer" },
    });
  }
  const selected = kinds.map((kind, index) => row(kind, `row-${index}`));
  const threads = kinds.includes("derived") ? [row("connected", "mounted-root"), ...selected] : selected;
  const remove = vi.fn(async (_thread: NavigationThreadSummary) => undefined);
  const archive = vi.fn(async () => undefined);
  const unlink = vi.fn(async () => undefined);
  render(<Sidebar
    backends={[]}
    browseMode="recents"
    directories={[]}
    threads={threads}
    loading={false}
    selectedItemKey={threadSummaryIdentityKey(selected[0]!)}
    onBrowseModeChange={() => undefined}
    onCreateThread={async () => undefined}
    onOpenLaunchpad={async () => undefined}
    onSelectThread={() => undefined}
    onRemoveRemoteThreadPin={options.canRemove === false ? undefined : remove}
    onArchiveThread={archive}
    onUnlinkThreads={unlink}
  />);
  for (const [index, thread] of selected.entries()) {
    fireEvent.click(screen.getByRole("button", { name: thread.title }),
      index === 0 ? {} : { ctrlKey: true, metaKey: true });
  }
  fireEvent.contextMenu(screen.getByRole("button", { name: selected[0]!.title }));
  return { selected, remove, archive, unlink };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__pwragentFederationTarget");
});

it("removes just the remote card from a mixed local and offline selection", async () => {
  const f = openSelection(["local", "disconnected"]);
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove 1 Thread from My List/ }));
  });
  expect(f.remove.mock.calls.map(([thread]) => thread)).toEqual([f.selected[1]]);
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.unlink).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});

it("offers and removes exactly the selected viewer-owned remote mounts", async () => {
  // Model: local rows and inherited children have no removable mount. Owner
  // connectivity/grants do not matter; a peer window has no viewer list.
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom<RowKind>("local", "connected", "disconnected", "derived"), {
      minLength: 2, maxLength: 5, size: "max",
    }),
    fc.boolean(),
    fc.boolean(),
    async (kinds, remoteWindow, canRemove) => {
      try {
        const f = openSelection(kinds, { remoteWindow, canRemove });
        const expected = remoteWindow || !canRemove ? [] : f.selected.filter((_thread, index) =>
          kinds[index] === "connected" || kinds[index] === "disconnected");
        const action = screen.queryByRole("menuitem", { name: /Remove .* from My List/ });
        expect(Boolean(action)).toBe(expected.length > 0);
        if (expected.length > 0) {
          expect(action).toHaveTextContent(`Remove ${expected.length} Thread${expected.length === 1 ? "" : "s"} from My List`);
          await act(async () => { fireEvent.click(action!); });
        }
        expect(f.remove.mock.calls.map(([thread]) => thread)).toEqual(expect.arrayContaining(expected));
        expect(f.remove).toHaveBeenCalledTimes(expected.length);
        expect(f.archive).not.toHaveBeenCalled();
        expect(f.unlink).not.toHaveBeenCalled();
      } finally {
        cleanup();
        Reflect.deleteProperty(window, "__pwragentFederationTarget");
      }
    },
  ), { numRuns: 25 });
});
