import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ManageThreadDependenciesResponse,
  ThreadDependency,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { DesktopApi } from "../../../lib/desktop-api";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { PrChip } from "../PrChip";
import { PullRequestMergeProvider, type PullRequestMergeService } from "../pull-request-merge-context";

/**
 * The sidebar card's merge, as the design has it: the pill runs the
 * project's method, the chevron lists only what the repository allows, every
 * path asks first, a pick from the list becomes the project's, and a held,
 * draft or federated PR offers nothing to click.
 */
const THREAD = { backend: "codex", threadId: "thread-a" } as const;

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 11,
    org: "acme",
    repo: "orbit",
    title: "Change 11",
    url: "https://github.com/acme/orbit/pull/11",
    baseRefName: "main",
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    allowedMergeMethods: ["squash", "rebase"],
    ...overrides,
  };
}

function hold(): ThreadDependency {
  return {
    id: "hold", backend: "codex", threadId: "thread-b", holdMerge: true, status: "waiting",
    mode: "all", onFailure: "notify", deliver: "operator", createdAt: 1, updatedAt: 1, evidence: [],
    conditions: [{ backend: "codex", threadId: "", when: "marked_done", subject: "Lab validation" }],
  };
}

function api(options: { remembered?: "squash" | "rebase" | "merge"; held?: boolean } = {}) {
  return {
    readThreadPullRequestMerge: vi.fn(async () => ({
      ...(options.remembered ? { remembered: options.remembered } : {}),
      fallback: "squash" as const,
    })),
    mergeThreadPullRequest: vi.fn(async () => ({ summary: "Squash-merged #11" })),
    manageThreadDependencies: vi.fn(async (): Promise<ManageThreadDependenciesResponse> => ({
      dependencies: [],
      mergeHolds: options.held ? [hold()] : [],
    })),
    onAgentEvent: () => () => {},
  };
}

function renderChip(summary: PrSummary, desktopApi: ReturnType<typeof api>) {
  const merge = vi.fn<PullRequestMergeService["merge"]>(async () => true);
  const service: PullRequestMergeService = { api: desktopApi as unknown as DesktopApi, merge };
  render(
    <aside className="sidebar">
      <PrChip
        pr={summary}
        showRepoPrefix={false}
        onOpen={vi.fn()}
        onDetach={vi.fn()}
        cardActions
        merge={{ thread: THREAD, service }}
      />
    </aside>,
  );
  return { merge };
}

async function openCard(): Promise<HTMLElement> {
  fireEvent.mouseEnter(screen.getByRole("button", { name: /Open acme\/orbit#11 / }));
  await act(async () => { vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS); });
  // The method and the holds arrive from main.
  await act(async () => {});
  return screen.getByRole("tooltip");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PrChip sidebar card merge", () => {
  it("runs the remembered method from the pill, after asking, without remembering again", async () => {
    const { merge } = renderChip(pr(), api({ remembered: "rebase" }));
    const card = await openCard();
    fireEvent.click(within(card).getByText("Rebase merge"));
    expect(within(card).getByText("Rebase and merge #11 into main?")).toBeInTheDocument();
    expect(merge).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(card).getByText("Rebase and merge"));
    });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({
      thread: THREAD, method: "rebase", rememberMethod: false,
    }));
  });

  it("lists only the repository's methods, and a pick from the list is remembered", async () => {
    const { merge } = renderChip(pr(), api());
    const card = await openCard();
    fireEvent.click(within(card).getByLabelText("Merge options"));
    expect(within(card).getByText("Squash and merge")).toBeInTheDocument();
    expect(within(card).getByText("Rebase and merge")).toBeInTheDocument();
    expect(within(card).queryByText("Create a merge commit")).toBeNull();

    fireEvent.click(within(card).getByText("Rebase and merge"));
    await act(async () => {
      fireEvent.click(within(card).getByText("Rebase and merge", { selector: "button" }));
    });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ method: "rebase", rememberMethod: true }));
  });

  it("goes back to the pill on Cancel without merging", async () => {
    const { merge } = renderChip(pr(), api());
    const card = await openCard();
    fireEvent.click(within(card).getByText("Squash merge"));
    fireEvent.click(within(card).getByText("Cancel"));
    expect(within(card).getByText("Squash merge")).toBeInTheDocument();
    expect(merge).not.toHaveBeenCalled();
  });

  it("says what a held merge waits for and offers no merge", async () => {
    renderChip(pr(), api({ held: true }));
    const card = await openCard();
    expect(within(card).getByText("Merge waits for Lab validation")).toBeInTheDocument();
    expect(within(card).queryByText("Squash merge")).toBeNull();
  });

  it("reads nothing and offers nothing for a draft", async () => {
    const desktopApi = api();
    renderChip(pr({ reviewState: "draft" }), desktopApi);
    const card = await openCard();
    expect(within(card).getByText("Copy URL")).toBeInTheDocument();
    expect(within(card).queryByText(/merge/i)).toBeNull();
    expect(desktopApi.readThreadPullRequestMerge).not.toHaveBeenCalled();
    expect(desktopApi.manageThreadDependencies).not.toHaveBeenCalled();
  });

  it("offers the queue, without a method list, when the base branch requires one", async () => {
    renderChip(pr({ mergeQueue: { kind: "merge_queue", state: "not_queued" } }), api());
    const card = await openCard();
    fireEvent.click(within(card).getByText("Add to merge queue"));
    expect(within(card).getByText("Add #11 to the merge queue for main?")).toBeInTheDocument();
    expect(within(card).queryByLabelText("Merge options")).toBeNull();
  });
});

describe("PullRequestMergeProvider", () => {
  it("reports the merge's result as a toast, success or failure", async () => {
    const desktopApi = api();
    const showNotice = vi.fn();
    let service: PullRequestMergeService | undefined;
    const { usePullRequestMergeService } = await import("../pull-request-merge-context");
    function Probe() {
      service = usePullRequestMergeService();
      return null;
    }
    render(
      <PullRequestMergeProvider desktopApi={desktopApi as unknown as DesktopApi} showNotice={showNotice}>
        <Probe />
      </PullRequestMergeProvider>,
    );
    await expect(service!.merge({ thread: THREAD, pr: pr(), method: "squash", rememberMethod: false })).resolves.toBe(true);
    expect(showNotice).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "success", title: "Squash-merged #11" }));

    desktopApi.mergeThreadPullRequest.mockRejectedValueOnce(
      new Error("Error invoking remote method 'thread-pull-request:merge': Error: gh pr merge failed: not mergeable"),
    );
    await expect(service!.merge({ thread: THREAD, pr: pr(), method: "squash", rememberMethod: false })).resolves.toBe(false);
    expect(showNotice).toHaveBeenLastCalledWith(expect.objectContaining({
      tone: "error", title: "Could not merge #11", message: "gh pr merge failed: not mergeable",
    }));
  });

  it("gives a window without the merge API no service", () => {
    let service: PullRequestMergeService | undefined = {} as PullRequestMergeService;
    return import("../pull-request-merge-context").then(({ usePullRequestMergeService }) => {
      function Probe() {
        service = usePullRequestMergeService();
        return null;
      }
      render(
        <PullRequestMergeProvider desktopApi={undefined} showNotice={vi.fn()}>
          <Probe />
        </PullRequestMergeProvider>,
      );
      expect(service).toBeUndefined();
    });
  });
});
