import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReadThreadFamilyPricingRequest,
  ReadThreadFamilyPricingResponse,
  ThreadFamilyPricingMember,
} from "@pwragent/shared";
import { ThreadLinkProvider } from "../../../../lib/thread-links";
import { ThreadFamilyPricingCard } from "../ThreadFamilyPricingCard";

afterEach(() => {
  cleanup();
});

function member(threadId: string, totalCostMicros: number, patch: Partial<ThreadFamilyPricingMember> = {}): ThreadFamilyPricingMember {
  return {
    backend: "codex",
    threadId,
    title: `Thread ${threadId}`,
    self: false,
    active: false,
    totalCostMicros,
    usageLineCount: 1,
    unpricedUsageLineCount: 0,
    ...patch,
  };
}

const family: ReadThreadFamilyPricingResponse = {
  readAt: Date.UTC(2026, 9, 7, 22, 15),
  members: [
    member("parent", 1_840_000, { self: true, title: "Billing export v2" }),
    member("csv", 920_000, { title: "Fork: CSV encoder edge cases" }),
    member("retry", 610_000, { title: "Retry policy for webhook sends" }),
    member("review", 370_000, { title: "Review billing export PR" }),
    member("schema", 120_000, { title: "Fork: schema check" }),
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function card(): HTMLElement | null {
  return document.querySelector(".thread-family-pricing");
}

describe("ThreadFamilyPricingCard", () => {
  it("reads nothing and renders nothing for a thread without sub-threads", () => {
    const readThreadFamilyPricing = vi.fn();
    render(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing }} backend="codex" threadId="parent" subThreadCount={0} />);
    expect(card()).toBeNull();
    expect(readThreadFamilyPricing).not.toHaveBeenCalled();
  });

  it("shows the family total, the sub-thread share, and each thread's spend", async () => {
    const readThreadFamilyPricing = vi.fn(async () => family);
    render(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing }} backend="codex" threadId="parent" subThreadCount={4} />);

    expect(card()).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByText("$3.86")).toBeInTheDocument();
    expect(readThreadFamilyPricing).toHaveBeenCalledWith({ backend: "codex", threadId: "parent" });
    expect(screen.getByText("sub-threads $2.02")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "This thread 48%, sub-threads 52%" })).toBeInTheDocument();
    expect(document.querySelectorAll(".thread-family-pricing__segment")).toHaveLength(5);
    expect(screen.getByText("This thread").closest(".thread-family-pricing__row"))
      .toHaveTextContent("This thread$1.84");
    expect(screen.getByText("Includes sub-agents")).toBeInTheDocument();
  });

  it("folds sub-threads past the four costliest into one row", async () => {
    const big: ReadThreadFamilyPricingResponse = {
      ...family,
      members: [...family.members, member("extra-1", 50_000), member("extra-2", 30_000)],
    };
    render(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing: async () => big }} backend="codex" threadId="parent" subThreadCount={6} />);

    const fold = await screen.findByRole("button", { name: /2 more sub-threads/ });
    expect(fold).toHaveTextContent("$0.08");
    expect(screen.queryByText("Thread extra-1")).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByText("Thread extra-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show fewer/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("warns about unpriced rows and says which threads are still running", async () => {
    const live: ReadThreadFamilyPricingResponse = {
      ...family,
      members: [
        family.members[0]!,
        member("csv", 920_000, { active: true, unpricedUsageLineCount: 2 }),
        member("retry", 610_000, { unpricedUsageLineCount: 1 }),
      ],
    };
    render(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing: async () => live }} backend="codex" threadId="parent" subThreadCount={2} />);

    expect(await screen.findByText("3 rows in 2 threads could not be priced")).toBeInTheDocument();
    expect(screen.getByText("1 thread running")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
  });

  it("keeps the last totals on screen while Refresh reads again", async () => {
    const next = deferred<ReadThreadFamilyPricingResponse>();
    const readThreadFamilyPricing = vi.fn()
      .mockResolvedValueOnce(family)
      .mockReturnValueOnce(next.promise);
    render(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing }} backend="codex" threadId="parent" subThreadCount={4} />);
    await screen.findByText("$3.86");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(readThreadFamilyPricing).toHaveBeenCalledTimes(2);
    expect(screen.getByText("$3.86")).toBeInTheDocument();
    expect(card()).not.toHaveAttribute("aria-busy");

    await act(async () => {
      next.resolve({ ...family, members: [family.members[0]!, member("csv", 2_160_000)] });
    });
    expect(screen.getByText("$4.00")).toBeInTheDocument();
  });

  it("reads again when a sub-thread is added", async () => {
    const readThreadFamilyPricing = vi.fn(async () => family);
    const view = render(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing }} backend="codex" threadId="parent" subThreadCount={4} />);
    await screen.findByText("$3.86");
    view.rerender(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing }} backend="codex" threadId="parent" subThreadCount={5} />);
    await waitFor(() => expect(readThreadFamilyPricing).toHaveBeenCalledTimes(2));
    expect(screen.getByText("$3.86")).toBeInTheDocument();
  });

  it("opens a sub-thread from its row", async () => {
    const onShowThread = vi.fn();
    render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[]}>
        <ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing: async () => family }} backend="codex" threadId="parent" subThreadCount={4} />
      </ThreadLinkProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Retry policy for webhook sends/ }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "retry" }));
  });

  it("offers a retry when the read fails", async () => {
    const readThreadFamilyPricing = vi.fn()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce(family);
    render(<ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing }} backend="codex" threadId="parent" subThreadCount={4} />);

    expect(await screen.findByText("Sub-thread totals could not be read.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("$3.86")).toBeInTheDocument();
  });

  it("keeps the owner on refresh and child navigation", async () => {
    const onShowThread = vi.fn();
    // Main stamps every member of a remote family with the owner that keeps it.
    const owned = { ...family, members: family.members.map((entry) => ({ ...entry, ownerInstanceId: "owner" })) };
    const readThreadFamilyPricing = vi.fn(async (_request: ReadThreadFamilyPricingRequest) => owned);
    render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[]}>
        <ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing }} backend="codex" threadId="parent"
          federationTarget={{ scope: "remote", instanceId: "owner" }} subThreadCount={4} />
      </ThreadLinkProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Retry policy for webhook sends/ }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "retry", instanceId: "owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(readThreadFamilyPricing).toHaveBeenCalledTimes(2));
    for (const [request] of readThreadFamilyPricing.mock.calls) {
      expect(request).toEqual({ backend: "codex", threadId: "parent", federationTarget: { scope: "remote", instanceId: "owner" } });
    }
  });

  it("counts sub-threads on other machines and names the machine on each row", async () => {
    const onShowThread = vi.fn();
    const spread: ReadThreadFamilyPricingResponse = {
      readAt: family.readAt,
      members: [
        member("parent", 14_160_000, { self: true, title: "Restore runner Xcode 26 readiness" }),
        member("m5", 3_200_000, { backend: "claude", title: "Xcode 26 actool runner readiness",
          ownerInstanceId: "pwr_m5", instanceLabel: "M5 Max / default", active: true }),
        member("pin", 1_480_000, { title: "Pin gh in macOS runner readiness" }),
        member("m2", 900_000, { title: "Investigate Xcode 26 readiness on M2",
          ownerInstanceId: "pwr_m2", instanceLabel: "M2 Max / default" }),
      ],
    };
    render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[]}>
        <ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing: async () => spread }} backend="codex" threadId="parent" subThreadCount={3} />
      </ThreadLinkProvider>,
    );

    expect(await screen.findByText("$19.74")).toBeInTheDocument();
    expect(screen.getByText("sub-threads $5.58")).toBeInTheDocument();
    const m5 = screen.getByRole("button", { name: /Xcode 26 actool runner readiness/ });
    expect(m5).toHaveTextContent("M5 Max / default");
    expect(m5).toHaveAttribute("title", "Open Xcode 26 actool runner readiness on M5 Max / default");
    // A row on this thread's own machine needs no machine name.
    expect(screen.getByRole("button", { name: /Pin gh in macOS runner readiness/ }).querySelector(".thread-family-pricing__machine")).toBeNull();
    expect(screen.getByText("1 thread running")).toBeInTheDocument();

    fireEvent.click(m5);
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude", threadId: "m5", instanceId: "pwr_m5", instanceLabel: "M5 Max / default",
    }));
  });

  it("lists a sub-thread on an unreachable machine without counting it", async () => {
    const partial: ReadThreadFamilyPricingResponse = {
      readAt: family.readAt,
      members: [
        member("parent", 1_840_000, { self: true }),
        member("csv", 920_000),
        member("m2", 0, { title: "Load test", ownerInstanceId: "pwr_m2", instanceLabel: "M2 Max", unavailable: true,
          usageLineCount: 0 }),
      ],
    };
    render(
      <ThreadLinkProvider onShowThread={vi.fn()} threads={[]}>
        <ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing: async () => partial }} backend="codex" threadId="parent" subThreadCount={2} />
      </ThreadLinkProvider>,
    );

    // The total is a floor while a machine is missing.
    expect(await screen.findByText("$2.76+")).toBeInTheDocument();
    expect(screen.getByText("1 sub-thread on M2 Max could not be read")).toBeInTheDocument();
    const row = screen.getByText("Load test").closest(".thread-family-pricing__row");
    expect(row).toHaveClass("thread-family-pricing__row--off");
    expect(row).toHaveTextContent("Load testM2 Maxnot included");
    expect(screen.queryByRole("button", { name: /Load test/ })).toBeNull();
    expect(document.querySelectorAll(".thread-family-pricing__segment")).toHaveLength(2);
  });

  it("names this machine on a remote thread's family and does not link it from a remote window", async () => {
    (window as typeof window & { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget = { scope: "remote", instanceId: "owner" };
    try {
      const remote: ReadThreadFamilyPricingResponse = {
        readAt: family.readAt,
        members: [
          member("parent", 1_000_000, { self: true, ownerInstanceId: "owner" }),
          member("sibling", 500_000, { title: "On the owner", ownerInstanceId: "owner" }),
          member("here", 250_000, { title: "Handed back here" }),
        ],
      };
      render(
        <ThreadLinkProvider onShowThread={vi.fn()} threads={[]}>
          <ThreadFamilyPricingCard desktopApi={{ readThreadFamilyPricing: async () => remote }} backend="codex" threadId="parent"
            federationTarget={{ scope: "remote", instanceId: "owner" }} subThreadCount={2} />
        </ThreadLinkProvider>,
      );
      expect(await screen.findByText("$1.75")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /On the owner/ })).not.toHaveTextContent("This machine");
      const here = screen.getByText("Handed back here").closest(".thread-family-pricing__row");
      expect(here).toHaveTextContent("Handed back hereThis machine$0.25");
      expect(here?.tagName).toBe("DIV");
    } finally {
      delete (window as typeof window & { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
    }
  });
});
