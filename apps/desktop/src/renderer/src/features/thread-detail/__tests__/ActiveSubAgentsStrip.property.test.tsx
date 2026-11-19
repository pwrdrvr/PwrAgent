import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ThreadActiveSubAgent } from "@pwragent/shared";
import { ActiveSubAgentsStrip } from "../ActiveSubAgentsStrip";

async function expectDismissalToSurviveRemount(count: number, bulk: boolean) {
  const target = { scope: "remote", instanceId: "owner" } as const;
  const failures: ThreadActiveSubAgent[] = Array.from({ length: count }, (_, index) => ({
    monitorId: `failed-${index}`,
    task: `Task ${index}`,
    status: index % 2 === 0 ? "failed" : "failure",
    createdAt: index,
    updatedAt: index,
  }));
  const ownerCards = new Map(failures.map((card) => [card.monitorId, card]));
  const dismissFailedSubAgents = vi.fn(async ({ monitorIds }: { monitorIds: string[] }) => {
    const dismissedCount = monitorIds.filter((id) => ownerCards.delete(id)).length;
    return { dismissedCount };
  });
  const desktopApi = { stopSubAgent: vi.fn(), dismissFailedSubAgents };
  const readOwner = (): NavigationThreadSummary => ({
    id: "mounted-parent",
    title: "Parent",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: true },
    federation: { ref: { backend: "codex", threadId: "parent", target }, instanceLabel: "Owner" },
    activeSubAgents: [...ownerCards.values()],
  });
  const view = render(<ActiveSubAgentsStrip thread={readOwner()} desktopApi={desktopApi} />);
  try {
    if (!bulk && count >= 3) {
      fireEvent.click(screen.getByRole("button", { name: `Failed sub-agents, ${count}` }));
    }
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {
        name: bulk ? `Dismiss all ${count} failed sub-agents` : "Dismiss failed sub-agent: Task 0",
      }));
    });
  } finally {
    view.unmount();
  }
  const reopened = render(<ActiveSubAgentsStrip thread={readOwner()} desktopApi={desktopApi} />);
  try {
    const expected = bulk ? 0 : count - 1;
    if (expected === 0) {
      expect(reopened.container).toBeEmptyDOMElement();
    } else {
      expect(screen.getByRole("button", { name: `Failed sub-agents, ${expected}` })).toBeVisible();
    }
    expect(dismissFailedSubAgents).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      threadId: "parent",
      federationTarget: target,
      monitorIds: bulk ? failures.map((card) => card.monitorId) : ["failed-0"],
    });
  } finally {
    reopened.unmount();
  }
}

it("keeps remote dismissals after reopening the composer, for single rows and batches", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 9 }), fc.boolean(), async (count, bulk) => {
    await expectDismissalToSurviveRemount(count, bulk);
  }), { numRuns: 25 });
});

it("keeps one dismissed failure gone after reopening the remote composer", async () => {
  await expectDismissalToSurviveRemount(1, false);
});

it("dismisses 102 failures in one owner request", async () => {
  await expectDismissalToSurviveRemount(102, true);
});
