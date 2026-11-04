import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { useMemo, type ComponentProps } from "react";
import { beforeAll, describe, it, vi } from "vitest";
import type { BackendModelOption, BackendSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import {
  codexCatalogWithChoiceArbitrary,
  expectModelDropdownToList,
  expectedModelDropdown,
} from "../../../test/model-catalog";
import { Composer as ProductionComposer } from "../Composer";

/**
 * The rule the review card broke: every model picker lists a catalog the
 * way the composer's model chip does (`buildModelMenu`). These generate
 * catalogs instead of naming one, so a superseded model, a provider's model
 * or an order nobody wrote down cannot slip past.
 */
function Composer(props: ComponentProps<typeof ProductionComposer>) {
  const desktopApi = useMemo<DesktopApi>(() => ({
    ...props.desktopApi,
    getNavigationQueryPage: props.desktopApi?.getNavigationQueryPage
      ?? (async (request) => navigationQueryFixture(request, props)),
  }), [props.desktopApi, props.directories, props.threads]);
  return <ProductionComposer {...props} desktopApi={desktopApi} />;
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

function codexBackend(models: BackendModelOption[]): BackendSummary {
  return {
    kind: "codex",
    label: "codex",
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
      steerTurn: false,
      transcriptPagination: true,
      toolUse: false,
      approvalRequests: true,
      multiDirectoryThreads: true,
      startReview: true,
      reviewRunner: true,
      reviewRunMode: true,
      reviewCodexSubAgent: true,
    },
    executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
    launchpadOptions: { models },
  } as BackendSummary;
}

async function renderThreadComposer(models: BackendModelOption[], threadModel: string) {
  render(
    <Composer
      backends={[codexBackend(models)]}
      desktopApi={{
        onAgentEvent: () => () => undefined,
        listModelSettingsRecents: async () => ({ recents: [] }),
        recordModelSettingsRecent: vi.fn(async () => undefined),
        startReview: vi.fn(),
      }}
      disabled={false}
      skills={[]}
      thread={{
        id: "codex-thread",
        title: "Codex thread",
        titleSource: "explicit",
        source: "codex",
        model: threadModel,
        executionMode: "default",
        linkedDirectories: [],
        inbox: { inInbox: false },
      }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

describe("composer model picker properties", () => {
  it("lists any catalog on the review card by the shared model menu rule", async () => {
    await fc.assert(fc.asyncProperty(codexCatalogWithChoiceArbitrary, async ([models, threadModel]) => {
      try {
        await renderThreadComposer(models, threadModel.id);
        fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "/review" } });
        fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });
        const reviewCard = screen.getByRole("group", { name: "Review target" });
        fireEvent.click(within(reviewCard).getByRole("button", { name: /^Review model(?::|$)/ }));
        const list = screen.getByRole("listbox", { name: /^Review model/ });
        // A review starts its own thread, so it offers every provider.
        expectModelDropdownToList(list, "Review model", expectedModelDropdown({ kind: "codex", models }));
      } finally {
        cleanup();
      }
    }), { numRuns: 10 });
  });

  it("lists an existing thread's own provider on the model chip by the same rule", async () => {
    await fc.assert(fc.asyncProperty(codexCatalogWithChoiceArbitrary, async ([models, threadModel]) => {
      try {
        await renderThreadComposer(models, threadModel.id);
        fireEvent.click(screen.getByRole("button", { name: /^Model(?::|$)/ }));
        const list = screen.getByRole("listbox", { name: "Model" });
        expectModelDropdownToList(list, "Model", expectedModelDropdown({
          kind: "codex",
          models,
          thread: { model: threadModel.id },
        }));
      } finally {
        cleanup();
      }
    }), { numRuns: 10 });
  });
});
