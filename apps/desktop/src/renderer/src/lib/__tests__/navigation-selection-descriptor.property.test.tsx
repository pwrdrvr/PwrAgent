import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import fc from "fast-check";
import type { AgentEvent, NavigationDirectoryRow, NavigationQueryPage, NavigationRow } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useBoundedNavigationWindow } from "../useBoundedNavigationWindow";

it("keeps selected-project counts equal to the owner when a sibling turn changes and descriptor reads land in either order", async () => {
  // An exact thread page embeds directory-wide counts. The owner population,
  // including the unselected sibling, is the oracle for every published count.
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 6 }), async (changes) => {
    let active = false;
    let revision = 0;
    let gated = false;
    let holdSelection = false;
    const replies: Array<() => void> = [];
    const selected: NavigationRow = { id: "selected", source: "codex", ref: { backend: "codex", threadId: "selected" },
      title: "Selected", titleSource: "explicit", rowRevision: "r", linkedDirectories: [], inbox: { inInbox: false },
      ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" };
    const key = "directory:project";
    const api: DesktopApi = { getNavigationQueryPage: async (request) => {
      const descriptor: NavigationDirectoryRow = { key, kind: "directory", label: "Project",
        counts: { total: 2, active: Number(active), unread: 0, review: 0 },
        pinnedRootCount: 0, unpinnedRootCount: 2, launchpadPresent: false };
      const exact = request.query.kind === "exact";
      const response: NavigationQueryPage = { protocol: 2, queryKey: JSON.stringify(request.query), generation: String(revision),
        ownerEpoch: "owner", countsRevision: String(revision), coverage: { state: "complete" }, complete: true,
        counts: exact ? { total: 1, active: 0, unread: 0, review: 0 } : descriptor.counts,
        entries: exact ? [{ row: selected, placement: { kind: "root" }, orderKey: "0" }] : [],
        ...(exact ? { selectionDirectory: descriptor } : { directories: [descriptor] }),
      };
      if (gated && exact === holdSelection) await new Promise<void>((resolve) => replies.push(resolve));
      return response;
    } };
    const hook = renderHook(() => useBoundedNavigationWindow({ desktopApi: api, enabled: true, visible: true,
      observeEvents: false, browseMode: "directories", selectedRef: selected.ref,
      attentionView: { id: "counts", promoteOnTurnEnd: true }, expandedByKey: { [key]: false }, unpinnedExpandedByKey: {},
    }));
    try {
      await act(async () => {});
      expect(hook.result.current.presentationReady).toBe(true);
      gated = true;
      for (const [index, next] of [true, ...changes, false].entries()) {
        active = next;
        revision += 1;
        // Exercise both completion orders. When the exact read is pending,
        // its old descriptor must not replace the new index descriptor.
        holdSelection = index % 2 === 0;
        const event = { backend: "codex", notification: { method: active ? "turn/started" : "turn/completed",
          params: { threadId: "unselected-sibling" } } } as AgentEvent;
        let refreshing!: Promise<void>;
        await act(async () => {
          hook.result.current.invalidate([{ scope: "local" }], event);
          refreshing = hook.result.current.refresh([{ scope: "local" }], true);
        });
        const first = holdSelection ? "directory-index" : "selected-context";
        expect(hook.result.current.resources.get(first)?.state.page?.countsRevision).toBe(String(revision));
        expect(hook.result.current.directories.find((directory) => directory.key === key)?.counts.active).toBe(Number(active));
        await act(async () => { replies.splice(0).forEach((reply) => reply()); await refreshing; });
        expect(hook.result.current.directories.find((directory) => directory.key === key)?.counts.active).toBe(Number(active));
      }
    } finally { hook.unmount(); replies.splice(0).forEach((reply) => reply()); }
  }), { numRuns: 25 });
});
