import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo, type ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationLaunchpadDraft, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { Composer as ProductionComposer } from "../Composer";

function Composer(props: ComponentProps<typeof ProductionComposer>) {
  const desktopApi = useMemo<DesktopApi>(() => ({
    ...props.desktopApi,
    getNavigationQueryPage: props.desktopApi?.getNavigationQueryPage
      ?? (async (request) => navigationQueryFixture(request, props)),
  }), [props.desktopApi, props.directories, props.threads]);
  return <ProductionComposer {...props} desktopApi={desktopApi} />;
}

function backendSummary(): BackendSummary {
  return {
    kind: "codex",
    label: "OpenAI",
    available: true,
    methods: ["thread/start", "turn/start"],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: false,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: true,
      transcriptPagination: true,
      toolUse: false,
      approvalRequests: true,
      multiDirectoryThreads: true,
    },
    executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
    launchpadOptions: {
      models: [{ id: "gpt-5.4", label: "GPT-5.4", supportsReasoning: true }],
      reasoningEfforts: ["low", "medium", "high"],
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const environmentThread: NavigationThreadSummary = {
  id: "thread-env",
  title: "Environment thread",
  titleSource: "explicit",
  source: "codex",
  executionMode: "default",
  linkedDirectories: [{ id: "project", kind: "local", label: "Demo", path: "/repo/demo" }],
  inbox: { inInbox: false },
  codexEnvironmentRuntime: { environmentId: "demo", environmentName: "Demo", executionTarget: "local" },
  codexEnvironmentOptions: [{
    id: "demo",
    name: "Demo",
    sourcePath: "/repo/demo/environment.toml",
    actions: [{ id: "work", name: "Work", command: "pnpm dev" }],
  }],
};

beforeAll(() => {
  const emptyRect = { bottom: 0, height: 0, left: 0, right: 0, toJSON: () => ({}), top: 0, width: 0, x: 0, y: 0 } as DOMRect;
  const textPrototype = Text.prototype as Text & {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  textPrototype.getClientRects ??= () => [];
  textPrototype.getBoundingClientRect ??= () => emptyRect;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => emptyRect;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.querySelector("style[data-test-row-css]")?.remove();
});

/**
 * Lays the row out the way app.css does for the parts the fold reads, and
 * gives every control a fixed width, so the measuring hook runs as it does in
 * the window. jsdom has no layout of its own.
 */
function installRowLayout(rowWidth: number) {
  const style = document.createElement("style");
  style.dataset.testRowCss = "";
  style.textContent = `
    .composer__setup { display: flex; column-gap: 4px; }
    .composer__pending-controls { display: contents; }
    .composer__fold-slot.is-folded { position: absolute; }
  `;
  document.head.append(style);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("composer__setup") ? rowWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.dataset.composerFold === "details"
      ? 120
      : this.classList.contains("model-settings")
        ? 150
        : this.classList.contains("composer__actions")
          ? 90
          : 28;
    return { bottom: 26, height: 26, left: 0, right: width, top: 0, width, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

async function settleFold() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe("composer controls layout", () => {
  it("draws the input and one control row inside the same box", () => {
    const { container } = render(
      <Composer
        backends={[backendSummary()]}
        disabled={false}
        onSetExecutionMode={async () => undefined}
        skills={[]}
        thread={environmentThread}
      />,
    );

    const box = container.querySelector(".composer__box");
    const setup = container.querySelector(".composer__setup");
    expect(box).not.toBeNull();
    expect(box?.querySelector(".composer-tiptap-input")).not.toBeNull();
    expect(setup?.parentElement).toBe(box);
    expect(container.querySelector(".composer__actions")?.parentElement).toBe(setup);
    // Send is icon-only; its label is still its name.
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".composer__toggle[aria-label='Plan mode']")).toBeNull();
  });

  it("merges project, checkout and machine into one Where pill on a new thread", () => {
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "No selected project",
      backend: "codex",
      executionMode: "default",
      prompt: "Inspect example.com",
      workMode: "local",
      createdAt: 1,
      updatedAt: 1,
    };

    const { container } = render(
      <Composer
        backends={[backendSummary()]}
        disabled={false}
        launchpad={launchpad}
        onCancelLaunchpad={() => undefined}
        onMaterializeLaunchpad={async () => undefined}
        onSelectDirectoryFromPicker={() => undefined}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />,
    );

    const setup = container.querySelector(".composer__setup") as HTMLElement;
    const where = within(setup).getByRole("button", { name: /^Where: No selected project/ });
    expect(within(setup).queryByRole("button", { name: "Choose a project" })).toBeNull();
    expect(within(setup).queryByRole("button", { name: /^Workspace mode/ })).toBeNull();
    fireEvent.click(where);
    const panel = screen.getByRole("dialog", { name: "Where this thread runs" });
    expect(within(panel).getByRole("button", { name: "Choose a project" })).toBeInTheDocument();
    expect(within(panel).getByLabelText(/^Workspace mode/)).toBeInTheDocument();
    expect(within(setup).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(setup).getByRole("button", { name: "Start thread" })).toBeInTheDocument();
  });

  it("keeps the row's tools and send actions while preserving pending-send enablement", async () => {
    const check = createDeferred<boolean>();
    const thread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Layout check",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };

    const { container } = render(
      <Composer
        backends={[backendSummary()]}
        desktopApi={{ startTurn: vi.fn() }}
        disabled={false}
        onBeforeStartTurn={() => check.promise}
        onSetExecutionMode={async () => undefined}
        skills={[]}
        thread={thread}
      />,
    );

    const setup = container.querySelector(".composer__setup");
    expect(container.querySelector(".composer__actions")?.parentElement).toBe(setup);

    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "Check pending send" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByTestId("composer-model-settings")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Thread options" })).toBeDisabled();

    await act(async () => {
      check.resolve(false);
    });
    expect(screen.getByTestId("composer-model-settings")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Thread options" })).toBeEnabled();
  });

  it("folds the Details-bound controls and then ▶ into ⋮ on a narrow row, keeping the pinned ones", async () => {
    // Access 28 + model 150 + attach 28 + ⋮ 28 + the Send group 90, with
    // four 4px gaps, is 340. The Details-bound controls (120px each) and ▶
    // do not fit beside them.
    installRowLayout(345);
    const { container } = render(
      <Composer
        backends={[backendSummary()]}
        desktopApi={{ pickFileFromDisk: vi.fn(), runCodexEnvironmentAction: vi.fn(), setCodexThreadEnvironment: vi.fn() }}
        disabled={false}
        onSetExecutionMode={async () => undefined}
        skills={[]}
        thread={environmentThread}
      />,
    );
    await settleFold();

    const setup = container.querySelector(".composer__setup") as HTMLElement;
    // No dictation here, so folding ends at ▶: attach still fits.
    expect(setup.dataset.foldedTiers).toBe("2");
    for (const slot of setup.querySelectorAll<HTMLElement>("[data-composer-fold='details'], [data-composer-fold='run']")) {
      expect(slot).toHaveClass("is-folded");
      expect(slot).toHaveAttribute("inert");
    }
    expect(within(setup).getByTestId("composer-model-settings")).toBeVisible();
    expect(within(setup).getByRole("button", { name: "Add reference" })).toBeInTheDocument();
    expect(within(setup).getByRole("button", { name: "Send" })).toBeInTheDocument();

    fireEvent.click(within(setup).getByRole("button", { name: "Thread options" }));
    const menu = screen.getByRole("menu", { name: "Thread options" });
    expect(within(menu).getByRole("menuitemradio", { name: /Demo/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /Work/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitem", { name: "Run Work" })).toBeInTheDocument();
    // Attach still fits, so ⋮ does not repeat it.
    expect(within(menu).queryByRole("menuitem", { name: "Add reference…" })).toBeNull();
  });

  it("keeps every control in the row when it fits", async () => {
    installRowLayout(2000);
    const { container } = render(
      <Composer
        backends={[backendSummary()]}
        desktopApi={{ runCodexEnvironmentAction: vi.fn(), setCodexThreadEnvironment: vi.fn() }}
        disabled={false}
        onSetExecutionMode={async () => undefined}
        skills={[]}
        thread={environmentThread}
      />,
    );
    await settleFold();

    const setup = container.querySelector(".composer__setup") as HTMLElement;
    expect(setup.dataset.foldedTiers).toBe("0");
    expect(setup.querySelector(".composer__fold-slot.is-folded")).toBeNull();
    fireEvent.click(within(setup).getByRole("button", { name: "Thread options" }));
    expect(within(screen.getByRole("menu", { name: "Thread options" })).queryByRole("menuitem", { name: "Run Work" })).toBeNull();
  });
});
