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
});

describe("composer controls layout", () => {
  it("shares one .composer__setup container between launchpad settings and send actions", () => {
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

    const setup = container.querySelector(".composer__setup");
    const actions = container.querySelector(".composer__actions");
    expect(setup).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(actions?.parentElement).toBe(setup);
    expect(container.querySelector(".composer__footer")).toBeNull();
    expect(container.querySelector(".composer__footer-spacer")).toBeNull();
    expect(within(setup as HTMLElement).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(setup as HTMLElement).getByRole("button", { name: "Start thread" })).toBeInTheDocument();
  });

  it("keeps Composer tools and send actions inside .composer__setup while preserving pending-send enablement", async () => {
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
        integratedTerminal={{
          open: false,
          onToggle: vi.fn(),
        }}
        onBeforeStartTurn={() => check.promise}
        onSetExecutionMode={async () => undefined}
        skills={[]}
        thread={thread}
      />,
    );

    const setup = container.querySelector(".composer__setup");
    const tools = screen.getByLabelText("Composer tools");
    const actions = container.querySelector(".composer__actions");
    expect(setup).not.toBeNull();
    expect(tools.parentElement).toBe(setup);
    expect(actions?.parentElement).toBe(setup);

    // Trigger preparingSend and confirm setup controls disable while Cancel and terminal toggle stay enabled.
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "Check pending send" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(tools).getByRole("button")).toBeEnabled();
    expect(screen.getByTestId("composer-model-settings")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Thread options" })).toBeDisabled();

    await act(async () => {
      check.resolve(false);
    });
    expect(screen.getByTestId("composer-model-settings")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Thread options" })).toBeEnabled();
  });
});
