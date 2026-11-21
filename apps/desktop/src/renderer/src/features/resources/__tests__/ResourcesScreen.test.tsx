import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResourceCheckoutActionRequest,
  ResourceCheckoutActionResult,
  ResourceCheckoutsChangedEvent,
  ResourceCheckoutsSnapshot,
} from "@pwragent/shared/contracts/resource-checkouts";
import { ResourcesScreen } from "../ResourcesScreen";
import { createDesktopResourceCheckoutsSource, type ResourceCheckoutsSource } from "../resource-checkouts-source";
import { buildPreviewSnapshot, createPreviewResourceCheckoutsSource } from "../preview/resource-checkouts-preview";

afterEach(() => {
  cleanup();
});

const NOW = Date.UTC(2026, 10, 21, 15, 0, 0);

function liveSource(initial: ResourceCheckoutsSnapshot) {
  let current = initial;
  const listeners = new Set<(event: ResourceCheckoutsChangedEvent) => void>();
  const perform = vi.fn(async (_request: ResourceCheckoutActionRequest): Promise<ResourceCheckoutActionResult> => ({
    outcome: "queued",
    queueEntryId: "q-new",
    position: 1,
  }));
  const source: ResourceCheckoutsSource = {
    origin: "live",
    read: vi.fn(async () => current),
    subscribe(onChanged) {
      listeners.add(onChanged);
      return () => listeners.delete(onChanged);
    },
    perform,
  };
  const publish = async (next: ResourceCheckoutsSnapshot) => {
    current = next;
    await act(async () => {
      for (const listener of listeners) listener({ revision: next.revision });
    });
  };
  return { source, perform, publish };
}

async function renderScreen(source: ResourceCheckoutsSource) {
  const onOpenThread = vi.fn();
  const view = render(<ResourcesScreen source={source} onClose={() => undefined} onOpenThread={onOpenThread} />);
  await act(async () => {});
  return { ...view, onOpenThread };
}

function row(name: string): HTMLElement {
  const title = screen.getAllByText(name).find((node) => node.classList.contains("resources-row__title"));
  if (!title) throw new Error(`no row ${name}`);
  return title.closest("li") as HTMLElement;
}

function selectRow(name: string) {
  fireEvent.click(within(row(name)).getByRole("button", { name: new RegExp(`^${name}`) }));
}

function inspector(): HTMLElement {
  return document.querySelector(".resources-inspector") as HTMLElement;
}

describe("ResourcesScreen", () => {
  it("labels preview data on the screen, and never labels a live source as preview", async () => {
    const preview = await renderScreen(createPreviewResourceCheckoutsSource({ now: () => NOW, latencyMs: 0 }));
    expect(screen.getByTestId("resources-preview-banner")).toHaveTextContent("actions are simulated");
    preview.unmount();

    await renderScreen(liveSource(buildPreviewSnapshot(NOW)).source);
    expect(screen.queryByTestId("resources-preview-banner")).toBeNull();
  });

  it("shows a cached busy resource behind an unreachable authority as unreachable, with its request blocked", async () => {
    await renderScreen(liveSource(buildPreviewSnapshot(Date.now())).source);
    expect(within(row("gpu-bench-02")).getByText("Authority unreachable")).toBeInTheDocument();
    selectRow("gpu-bench-02");
    const request = within(inspector()).getByTestId("resources-action-request");
    expect(request).toHaveAttribute("aria-disabled", "true");
    expect(request.getAttribute("data-tooltip")).toMatch(/can't be reached/);
  });

  it("keeps busy, unreachable, interactive and unresolved resources distinct", async () => {
    await renderScreen(liveSource(buildPreviewSnapshot(Date.now())).source);
    const conditionOf = (name: string) => row(name).querySelector("[data-condition]")?.getAttribute("data-condition");
    expect(conditionOf("studio-m4 quiet benchmark window")).toBe("busy");
    expect(conditionOf("gpu-bench-02")).toBe("unreachable");
    expect(conditionOf("win-lab-07")).toBe("waiting_interactive");
    expect(conditionOf("lin-ci-box")).toBe("ownership_unresolved");
    expect(conditionOf("mac-lab-03")).toBe("recovery_required");
  });

  it("does not show a request as queued until the authority's snapshot says so", async () => {
    const base = buildPreviewSnapshot(Date.now());
    const { source, perform, publish } = liveSource(base);
    await renderScreen(source);
    selectRow("win-lab-07");
    fireEvent.click(within(inspector()).getByTestId("resources-action-request"));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("What the checkout is for"), { target: { value: "Retry headed suite" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Join queue" }));
    });
    expect(perform).toHaveBeenCalledTimes(1);
    const request = perform.mock.calls[0]![0];
    expect(request).toMatchObject({ kind: "request", resourceId: "res-win", purpose: "Retry headed suite" });
    expect(request.idempotencyKey).toMatch(/^rco-/);
    // The authority said "queued", but no snapshot shows it yet.
    expect(within(row("win-lab-07")).getByLabelText("1 waiting")).toBeInTheDocument();

    await publish({
      ...base,
      revision: base.revision + 1,
      resources: base.resources.map((resource) => resource.resourceId === "res-win"
        ? {
          ...resource,
          queue: [
            ...resource.queue,
            { queueEntryId: "q-new", position: 2, requester: { kind: "operator", label: "You" }, purpose: "Retry headed suite", requestedAt: Date.now(), eligibility: { eligible: true }, viewerOwns: true },
          ],
          actions: { ...resource.actions, cancel_request: { allowed: true } },
        }
        : resource),
    });
    expect(within(row("win-lab-07")).getByLabelText("2 waiting")).toBeInTheDocument();
    expect(within(inspector()).getByTestId("resources-action-cancel_request")).toBeInTheDocument();
  });

  it("keeps the newer snapshot when an older read lands late", async () => {
    const base = buildPreviewSnapshot(Date.now());
    const reads: Array<(snapshot: ResourceCheckoutsSnapshot) => void> = [];
    let emit: ((event: ResourceCheckoutsChangedEvent) => void) | undefined;
    const source: ResourceCheckoutsSource = {
      origin: "live",
      read: () => new Promise((resolve) => reads.push(resolve)),
      subscribe(onChanged) {
        emit = onChanged;
        return () => undefined;
      },
      perform: vi.fn(),
    };
    render(<ResourcesScreen source={source} onOpenThread={() => undefined} />);
    await act(async () => emit!({ revision: 3 }));
    expect(reads).toHaveLength(2);
    const renamed = (revision: number, name: string): ResourceCheckoutsSnapshot => ({
      ...base,
      revision,
      resources: base.resources.map((resource) => resource.resourceId === "res-serial" ? { ...resource, displayName: name } : resource),
    });
    await act(async () => reads[1]!(renamed(3, "bench rig rev 3")));
    await act(async () => reads[0]!(renamed(2, "bench rig rev 2")));
    expect(screen.getAllByText("bench rig rev 3").length).toBeGreaterThan(0);
    expect(screen.queryByText("bench rig rev 2")).toBeNull();
  });

  it("blocks administrative release until fencing is verified and an audit note is written", async () => {
    await renderScreen(createPreviewResourceCheckoutsSource({ latencyMs: 0 }));
    selectRow("mac-lab-03");
    fireEvent.click(within(inspector()).getByTestId("resources-action-recover"));
    const dialog = screen.getByRole("dialog");
    const admin = () => within(screen.getByRole("dialog")).getByRole("button", { name: "Administrative release" });
    expect(admin()).toHaveAttribute("aria-disabled", "true");
    expect(admin().getAttribute("data-tooltip")).toMatch(/verified fencing/);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Fence old workload" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {});
    expect(admin()).toHaveAttribute("aria-disabled", "true");
    expect(admin().getAttribute("data-tooltip")).toMatch(/audit note/);

    fireEvent.change(within(screen.getByRole("dialog")).getByPlaceholderText("Why the owner can't complete its own cleanup"), {
      target: { value: "Executor fenced; owner thread is archived." },
    });
    expect(admin()).not.toHaveAttribute("aria-disabled");
  });

  it("opens the holder's thread from the inspector", async () => {
    const { onOpenThread } = await renderScreen(liveSource(buildPreviewSnapshot(Date.now())).source);
    selectRow("win-lab-07");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Verify installer shutdown on Windows" }));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-win" }));
  });
});

describe("createDesktopResourceCheckoutsSource", () => {
  it("returns no source unless the main process serves all three calls", () => {
    expect(createDesktopResourceCheckoutsSource(undefined)).toBeNull();
    expect(createDesktopResourceCheckoutsSource({ readResourceCheckouts: async () => buildPreviewSnapshot(NOW) })).toBeNull();
    const source = createDesktopResourceCheckoutsSource({
      readResourceCheckouts: async () => buildPreviewSnapshot(NOW),
      onResourceCheckoutsChanged: () => () => undefined,
      performResourceCheckoutAction: async () => ({ outcome: "accepted" }),
    });
    expect(source?.origin).toBe("live");
  });
});
