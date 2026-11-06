import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import fc from "fast-check";
import { useMemo, type ComponentProps } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { NavigationDirectorySummary, NavigationLaunchpadDraft, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { Composer as ProductionComposer } from "../Composer";
import { handoffLaunchpadComposer } from "../launchpad-composer-handoff";
import { buildStartingLaunchpadComposerScopeKey } from "../launchpad-composer-scope";
import { buildThreadComposerScopeKey, useComposerDraftStore, type ComposerDraftSnapshot } from "../useComposerDraftStore";

function Composer(props: ComponentProps<typeof ProductionComposer>) {
  const { directories, threads } = props;
  const desktopApi = useMemo<DesktopApi>(() => ({
    getNavigationQueryPage: async (request) => navigationQueryFixture(request, { directories, threads }),
  }), [directories, threads]);
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

const directory: NavigationDirectorySummary = {
  key: "directory:/repo", kind: "directory", label: "Repo", path: "/repo",
  threadKeys: [], needsAttentionCount: 0,
};
const source = buildStartingLaunchpadComposerScopeKey("creation", directory.key);
const thread: NavigationThreadSummary = {
  id: "created-thread", source: "codex", title: "Submitted message", titleSource: "explicit",
  linkedDirectories: [], inbox: { inInbox: false }, optimisticActiveTurn: { id: "first-turn" },
};
const target = buildThreadComposerScopeKey(thread.source, thread.id);

function snapshot(text: string, image: boolean, file: boolean, kind = "submitted"): ComposerDraftSnapshot {
  return {
    draft: text,
    editorDocument: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    imageAttachments: image ? [{
      id: `${kind}-image`, name: `${kind}.png`, type: "image/png", size: 3,
      url: "data:image/png;base64,AQID", width: 32, height: 24,
    }] : [],
    fileAttachments: file ? [{ id: `${kind}-file`, label: `${kind}.txt`, path: `/repo/${kind}.txt` }] : [],
    skillTokens: [],
  };
}

type DraftPhase = "starting" | "thread";

function mountStartingComposer(submitted: ComposerDraftSnapshot, followUp?: ComposerDraftSnapshot) {
  const { result } = renderHook(useComposerDraftStore);
  const store = result.current;
  if (followUp) store.set(source, followUp);
  const launchpad: NavigationLaunchpadDraft = {
    directoryKey: directory.key, directoryKind: "directory", directoryLabel: "Repo", directoryPath: "/repo",
    backend: "codex", executionMode: "default", workMode: "worktree", createdAt: 1, updatedAt: 1,
    prompt: submitted.draft, editorDocument: submitted.editorDocument,
    imageAttachments: submitted.imageAttachments, fileAttachments: submitted.fileAttachments,
  };
  let phase: DraftPhase = "starting";
  const element = () => phase === "starting"
    ? <Composer directory={directory} launchpad={launchpad} launchpadMaterializing
        launchpadComposerScopeKey={source} draftStore={store} skills={[]} />
    : <Composer thread={thread} activeTurnId="first-turn" draftStore={store} skills={[]} />;
  let view = render(element());
  const input = () => screen.getByLabelText(phase === "starting" ? "New thread" : "Reply");
  return {
    remount: () => {
      view.unmount();
      view = render(element());
    },
    materialize: () => {
      act(() => handoffLaunchpadComposer(store, source, thread));
      phase = "thread";
      view.rerender(element());
      expect(store.get(source)).toBeUndefined();
    },
    edit: (text: string) => fireEvent.change(input(), { target: { value: text } }),
    assertDraft: (expected?: ComposerDraftSnapshot) => {
      // Startup context has been submitted. Only explicit follow-up content
      // belongs to the editor, the draft store, and its presence indicator.
      const scopeKey = phase === "starting" ? source : target;
      const current = store.get(scopeKey);
      expect(input()).toHaveValue(expected?.draft ?? "");
      expect(current?.draft ?? "").toBe(expected?.draft ?? "");
      expect(current?.imageAttachments ?? []).toEqual(expected?.imageAttachments ?? []);
      expect(current?.fileAttachments ?? []).toEqual(expected?.fileAttachments ?? []);
      expect(current?.skillTokens ?? []).toEqual(expected?.skillTokens ?? []);
      expect(store.hasDraftContent(scopeKey)).toBe(Boolean(
        expected?.draft || expected?.imageAttachments.length || expected?.fileAttachments?.length,
      ));
      expect(screen.queryByAltText("submitted.png")).toBeNull();
    },
  };
}

async function settleEditor() {
  await act(async () => { await Promise.resolve(); });
}

async function checkStartingComposer(submitted: ComposerDraftSnapshot, followUp?: ComposerDraftSnapshot) {
  const real = mountStartingComposer(submitted, followUp);
  await settleEditor();
  real.assertDraft(followUp);
  real.materialize();
  await settleEditor();
  real.assertDraft(followUp);
}

type DraftModel = { phase: DraftPhase; draft?: ComposerDraftSnapshot };
type DraftSystem = ReturnType<typeof mountStartingComposer>;

class Remount implements fc.AsyncCommand<DraftModel, DraftSystem> {
  check = () => true;
  toString = () => "remount";
  async run(model: DraftModel, real: DraftSystem) {
    real.remount();
    await settleEditor();
    real.assertDraft(model.draft);
  }
}

class Edit implements fc.AsyncCommand<DraftModel, DraftSystem> {
  constructor(private readonly text: string) {}
  check = () => true;
  toString = () => `edit(${JSON.stringify(this.text)})`;
  async run(model: DraftModel, real: DraftSystem) {
    real.edit(this.text);
    model.draft = {
      draft: this.text,
      imageAttachments: model.draft?.imageAttachments ?? [],
      fileAttachments: model.draft?.fileAttachments ?? [],
      skillTokens: [],
    };
    await settleEditor();
    real.assertDraft(model.draft);
  }
}

class Materialize implements fc.AsyncCommand<DraftModel, DraftSystem> {
  check = (model: Readonly<DraftModel>) => model.phase === "starting";
  toString = () => "materialize";
  async run(model: DraftModel, real: DraftSystem) {
    real.materialize();
    model.phase = "thread";
    await settleEditor();
    real.assertDraft(model.draft);
  }
}

const textArbitrary = fc.stringMatching(/^[a-z]{1,24}$/);
const snapshotArbitrary = (kind: string) => fc.record({
  text: textArbitrary,
  image: fc.boolean(),
  file: fc.boolean(),
  richText: fc.boolean(),
}).map(({ text, image, file, richText }) => {
  const draft = snapshot(`${kind} ${text}`, image, file, kind);
  if (!richText) draft.editorDocument = undefined;
  return draft;
});
const followUpArbitrary = fc.option(snapshotArbitrary("follow-up"), { nil: undefined });

describe("launchpad submission draft ownership", () => {
  it.each([
    { name: "the submitted prompt, image, and file", submitted: snapshot("Already sent", true, true) },
    { name: "a submitted document without attachments", submitted: snapshot("submitted a", false, false) },
  ])("does not restore $name when a starting composer mounts", async ({ submitted }) => {
    try {
      await checkStartingComposer(submitted);
    } finally {
      cleanup();
    }
  });

  it("hands off only unsent follow-up content for any submitted document and attachments", async () => {
    await fc.assert(fc.asyncProperty(
      snapshotArbitrary("submitted"), followUpArbitrary,
      async (submitted, followUp) => {
        try {
          await checkStartingComposer(submitted, followUp);
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 25 });
  });

  it("matches an unsent-content model through edits, clears, remounts, and materialization", async () => {
    const commands = fc.commands([
      fc.constant(new Remount()),
      fc.oneof(fc.constant(""), textArbitrary.map((text) => `Edited ${text}`)).map((text) => new Edit(text)),
      fc.constant(new Materialize()),
    ], { maxCommands: 6 });
    await fc.assert(fc.asyncProperty(
      snapshotArbitrary("submitted"), followUpArbitrary, commands,
      async (submitted, followUp, sequence) => {
        try {
          // The oracle changes only when the operator edits. Mounting and
          // handing off a submitted launchpad cannot create unsent content.
          const model: DraftModel = { phase: "starting", draft: followUp };
          const real = mountStartingComposer(submitted, followUp);
          await settleEditor();
          real.assertDraft(model.draft);
          await fc.asyncModelRun(() => ({ model, real }), sequence);
          if (model.phase === "starting") await new Materialize().run(model, real);
          await new Remount().run(model, real);
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 25 });
  });
});
