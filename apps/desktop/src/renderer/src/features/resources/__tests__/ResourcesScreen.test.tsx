import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResourceCheckoutActionRequest,
  ResourceCheckoutActionResult,
  ResourceCheckoutsChangedEvent,
  ResourceCheckoutsSnapshot,
  ResourceDomain,
} from "@pwragent/shared/contracts/resource-checkouts";
import { RequestCheckoutDialog } from "../ResourceDialogs";
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

  it("explains unresolved ownership and resolves it through a confirmation dialog", async () => {
    const base = buildPreviewSnapshot(Date.now());
    const { source, perform } = liveSource(base);
    perform.mockResolvedValueOnce({ outcome: "accepted", message: "Ownership resolved." });
    await renderScreen(source);
    selectRow("lin-ci-box");
    const unresolved = base.resources.find((resource) => resource.displayName === "lin-ci-box")!;
    const resolution = unresolved.ownershipConflict!.resolution!;
    const note = within(inspector()).getByRole("note");
    expect(note).toHaveTextContent(unresolved.ownershipConflict!.reason);
    expect(within(note).getByTestId("resources-callout-next-step")).toHaveTextContent(unresolved.ownershipConflict!.remedy);
    expect(within(inspector()).queryByTestId("resources-action-request")).toBeNull();

    fireEvent.click(within(note).getByTestId("resources-action-resolve"));
    const dialog = screen.getByRole("dialog", { name: `Resolve ownership of ${unresolved.displayName}?` });
    expect(dialog).toHaveTextContent(resolution.consequence);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: resolution.label }));
    });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform.mock.calls[0]![0]).toMatchObject({
      kind: "resolve_ownership",
      resourceId: unresolved.resourceId,
      resolution: resolution.kind,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("checks the canonical identity as it is typed, by the authority's rule", async () => {
    const base = buildPreviewSnapshot(Date.now());
    const { source, perform } = liveSource(base);
    await renderScreen(source);
    fireEvent.click(screen.getByRole("button", { name: "Register Resource" }));
    const dialog = screen.getByRole("dialog", { name: "Register resource" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Bench scope" } });
    const key = within(dialog).getByRole("textbox", { name: "Canonical identity" });
    const save = within(dialog).getByRole("button", { name: "Save draft" });

    fireEvent.change(key, { target: { value: "machine:abc:cpu" } });
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key).toHaveAccessibleDescription(/reserved/);
    expect(save).toBeDisabled();

    fireEvent.change(key, { target: { value: "Bench Scope" } });
    expect(key).toHaveAccessibleDescription(/lowercase scheme/);
    expect(save).toBeDisabled();

    fireEvent.change(key, { target: { value: (key as HTMLInputElement).placeholder } });
    expect(key).not.toHaveAttribute("aria-invalid");
    expect(save).toBeEnabled();
    await act(async () => {
      fireEvent.click(save);
    });
    expect(perform.mock.calls[0]![0]).toMatchObject({
      kind: "register_definition",
      draft: { canonicalKey: (key as HTMLInputElement).placeholder },
    });
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

  it("resends the same idempotency key when Extend is retried after an unknown outcome", async () => {
    const base = buildPreviewSnapshot(Date.now());
    const held: ResourceCheckoutsSnapshot = {
      ...base,
      resources: base.resources.map((resource) => resource.resourceId === "res-serial"
        ? {
          ...resource,
          condition: "busy",
          allocations: [{ allocationId: "alloc-held", state: "granted", holder: { kind: "operator", label: "You" }, taskLabel: "Flash", executorLabel: "atlas-mini · default", grantedAt: NOW, deadlineAt: NOW + 30 * 60_000, renewalsUsed: 0, renewalsAllowed: 1, generation: 4, authorityEpoch: 2, lastKnown: false, viewerOwns: true }],
          actions: { ...resource.actions, extend: { allowed: true }, release: { allowed: true } },
        }
        : resource),
    };
    const { source, perform } = liveSource(held);
    perform
      .mockResolvedValueOnce({ outcome: "unknown", message: "The broker did not answer." })
      .mockResolvedValueOnce({ outcome: "accepted", message: "Extended." })
      .mockResolvedValueOnce({ outcome: "accepted", message: "Extended." });
    await renderScreen(source);
    selectRow("bench serial rig");
    const extend = async () => {
      await act(async () => {
        fireEvent.click(within(inspector()).getByTestId("resources-action-extend"));
      });
    };
    await extend();
    await extend();
    await extend();
    const keys = perform.mock.calls.map(([request]) => request.idempotencyKey);
    expect(perform.mock.calls[0]![0]).toMatchObject({ kind: "extend", allocationId: "alloc-held", generation: 4 });
    // The retry after "unknown" cannot apply twice; a new extend after a
    // definite answer is a new intent.
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("moves the inspector off a resource the scope hides", async () => {
    await renderScreen(createPreviewResourceCheckoutsSource({ latencyMs: 0 }));
    selectRow("win-lab-07");
    expect(within(inspector()).getAllByText("win-lab-07").length).toBeGreaterThan(0);
    const thisMachine = screen.getAllByRole("button", { name: "This machine" })
      .find((button) => button.hasAttribute("aria-pressed"));
    await act(async () => {
      fireEvent.click(thisMachine!);
    });
    expect(within(inspector()).queryByText("win-lab-07")).toBeNull();
    expect(row("studio-m4 compute")).toBeInTheDocument();
  });

  it("reports a dialog's failure in the dialog only", async () => {
    const base = buildPreviewSnapshot(Date.now());
    const { source, perform } = liveSource(base);
    perform.mockResolvedValueOnce({ outcome: "rejected", reason: "not_authorized", message: "Not allowed for this profile." });
    await renderScreen(source);
    selectRow("win-lab-07");
    fireEvent.click(within(inspector()).getByTestId("resources-action-request"));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("What the checkout is for"), { target: { value: "Retry headed suite" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Join queue" }));
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Not allowed for this profile.");
    expect(document.querySelector(".resources-notice")).toBeNull();
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

  it("replays an unknown recovery intent but uses a fresh key after a confirmed rejection", async () => {
    const { source, perform } = liveSource(buildPreviewSnapshot(Date.now()));
    perform.mockResolvedValueOnce({ outcome: "unknown", message: "Response lost" });
    perform.mockResolvedValueOnce({ outcome: "rejected", reason: "fencing_required", message: "Still running" });
    perform.mockResolvedValueOnce({ outcome: "accepted" });
    await renderScreen(source);
    selectRow("mac-lab-03");
    fireEvent.click(within(inspector()).getByTestId("resources-action-recover"));
    for (let attempt = 0; attempt < 3; attempt++) {
      await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Fence old workload" })));
    }
    const [first, second, third] = perform.mock.calls.map(([request]) => request);
    expect(second).toEqual(first);
    expect(third.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("recovers the selected allocation and never retargets its dialog after release", async () => {
    const base = buildPreviewSnapshot(NOW);
    const resource = base.resources.find(({ displayName }) => displayName === "mac-lab-03")!;
    const first = { ...resource.recovery!, allocationId: "missing", generation: 1, actions: {} };
    const second = { ...resource.recovery!, allocationId: "selected", generation: 2, actions: { fence: { allowed: true as const } } };
    const failed: ResourceDomain = {
      ...resource,
      recovery: first, recoveries: [first, second], actions: {},
      allocations: [
        { ...resource.allocations[0], allocationId: first.allocationId, generation: first.generation, taskLabel: "Missing process group" },
        { ...resource.allocations[0], allocationId: second.allocationId, generation: second.generation, taskLabel: "Finished shard" },
      ],
    };
    const snapshot = (revision: number, replacement: ResourceDomain) => ({
      ...base, revision, resources: base.resources.map((candidate) => candidate === resource ? replacement : candidate),
    });
    const { source, perform, publish } = liveSource(snapshot(base.revision, failed));
    await renderScreen(source);
    selectRow(resource.displayName);
    expect(within(inspector()).queryByRole("button", { name: "Recover Missing process group" })).toBeNull();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Recover Finished shard" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Fence old workload" }));
    });
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({
      kind: "fence", allocationId: second.allocationId, generation: second.generation,
    }));
    await publish(snapshot(base.revision + 1, { ...failed, recoveries: [first], allocations: failed.allocations.slice(0, 1) }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("This allocation no longer needs recovery.")).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Fence old workload" })).toBeNull();
  });

  it.each([1, 2, 5])("sends the selected number of counted units (%i) and predicts the queue", async (units) => {
    const resource = buildPreviewSnapshot(NOW).resources[0];
    const submit = vi.fn(async (_request: ResourceCheckoutActionRequest): Promise<ResourceCheckoutActionResult> => ({ outcome: "accepted" }));
    render(<RequestCheckoutDialog resource={{ ...resource, queue: [], sharing: { mode: "counted", capacity: 5, inUse: 3, unitLabel: "slots" } }}
      action={{ kind: "request", label: "Request checkout", gate: { allowed: true }, emphasis: "primary" }} now={NOW} submit={submit} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Choose slots" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "CPU slots" }), { target: { value: String(units) } });
    fireEvent.change(screen.getByPlaceholderText("What the checkout is for"), { target: { value: "Partial grant" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: units > 2 ? "Join queue" : "Request checkout" })));
    expect(submit.mock.calls[0][0]).toMatchObject({ kind: "request", units });
  });

  it("lets a full machine request follow the authority's capacity", async () => {
    const resource = buildPreviewSnapshot(NOW).resources[0];
    const submit = vi.fn(async (_request: ResourceCheckoutActionRequest): Promise<ResourceCheckoutActionResult> => ({ outcome: "accepted" }));
    render(<RequestCheckoutDialog resource={resource}
      action={{ kind: "request", label: "Request checkout", gate: { allowed: true }, emphasis: "primary" }}
      now={NOW} submit={submit} onClose={() => undefined} />);
    expect(screen.getByRole("radio", { name: "All CPU slots", checked: true })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("What the checkout is for"), { target: { value: "Full test suite" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Join queue" })));
    expect(submit.mock.calls[0][0]).not.toHaveProperty("units");
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

describe("ResourcesScreen focus", () => {
  it("selects a focused resource, clearing a search that hid it, and again on each new request", async () => {
    const { source } = liveSource(buildPreviewSnapshot(NOW));
    const view = render(<ResourcesScreen source={source} onOpenThread={() => undefined} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter by name, kind or identity" }), { target: { value: "serial" } });
    expect(screen.queryByText("gpu-bench-02", { selector: ".resources-row__title" })).not.toBeInTheDocument();

    view.rerender(<ResourcesScreen source={source} focus={{ resourceId: "res-gpu", nonce: 1 }} onOpenThread={() => undefined} />);
    await act(async () => {});
    expect(screen.getByRole("searchbox", { name: "Filter by name, kind or identity" })).toHaveValue("");
    expect(within(inspector()).getByRole("heading", { name: "gpu-bench-02" })).toBeInTheDocument();

    // The operator moves on; the same request does not pull them back.
    selectRow("bench serial rig");
    view.rerender(<ResourcesScreen source={source} focus={{ resourceId: "res-gpu", nonce: 1 }} onOpenThread={() => undefined} />);
    await act(async () => {});
    expect(within(inspector()).getByRole("heading", { name: "bench serial rig" })).toBeInTheDocument();

    // Asking again from a thread does.
    view.rerender(<ResourcesScreen source={source} focus={{ resourceId: "res-gpu", nonce: 2 }} onOpenThread={() => undefined} />);
    await act(async () => {});
    expect(within(inspector()).getByRole("heading", { name: "gpu-bench-02" })).toBeInTheDocument();
  });

  it("explains why each queued request has not started", async () => {
    const base = buildPreviewSnapshot(NOW);
    const snapshot: ResourceCheckoutsSnapshot = {
      ...base,
      resources: base.resources.map((resource) => resource.resourceId !== "res-compute" ? resource : {
        ...resource,
        queue: [...resource.queue, {
          queueEntryId: "q-small", position: 2, requester: { kind: "operator", label: "You" }, purpose: "Lint",
          requestedAt: NOW - 60_000, units: 1, eligibility: { eligible: true }, viewerOwns: true,
        }],
      }),
    };
    await renderScreen(liveSource(snapshot).source);
    selectRow("studio-m4 compute");
    const holds = within(inspector()).getAllByTestId("resources-queue-hold").map((node) => node.textContent);
    expect(holds).toEqual([
      "Needs 2 CPU slots, 1 free. Starts when 1 more frees up.",
      "Would fit now (1 of 1 free), but waits for #1: would delay #1.Fits now",
    ]);
  });
});

describe("readResourcesHashFocus", () => {
  it("reads the resource from the window hash and nothing else", async () => {
    const { readResourcesHashFocus } = await import("../ResourcesWindow");
    expect(readResourcesHashFocus("#resources")).toBeUndefined();
    expect(readResourcesHashFocus("#resources-preview")).toBeUndefined();
    expect(readResourcesHashFocus(`#resources/${encodeURIComponent("machine:mach_1:cpu")}`)).toEqual({ resourceId: "machine:mach_1:cpu", nonce: 0 });
    expect(readResourcesHashFocus("#resources/%E0%A4%A")).toBeUndefined();
    expect(readResourcesHashFocus(`#resources/${"x".repeat(513)}`)).toBeUndefined();
  });
});
