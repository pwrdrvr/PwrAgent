import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexModelProviderLabels,
  type AppServerBackendKind,
  type NavigationThreadSummary,
  type ProviderPickerBackend,
} from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";
import { ThreadHeader } from "../../thread-detail/ThreadHeader";
import { ThreadProvidersContext } from "../provider-chip-visibility";
import {
  ThreadProviderCatalogsContext,
  formatThreadProviderLabel,
  type ThreadProviderCatalogs,
} from "../../../lib/thread-provider-label";

afterEach(() => {
  cleanup();
});

/**
 * Two OpenAI-compatible providers registered for Codex, beside OpenAI
 * itself. Both serve `gpt-oss-120b`. MathOS and its URL are placeholders.
 */
const localCodex: ProviderPickerBackend = {
  kind: "codex",
  launchpadOptions: {
    models: [
      { id: "gpt-oss-120b" },
      { id: "@mathos/gpt-oss-120b", providerId: "mathos", providerLabel: "MathOS" },
      { id: "@refuseless/gpt-oss-120b", providerId: "refuseless", providerLabel: "Refuseless" },
    ],
  },
  codexModelProviders: [
    { id: "mathos", name: "MathOS", status: "ready", listedCount: 0, discoveredCount: 1 },
    { id: "refuseless", name: "Refuseless", status: "ready", listedCount: 0, discoveredCount: 1 },
  ],
};

/** A peer that registered a different endpoint under the same id. */
const peerCodex: ProviderPickerBackend = {
  kind: "codex",
  launchpadOptions: { models: [{ id: "@mathos/x", providerId: "mathos", providerLabel: "Peer MathOS" }] },
};

const catalogs: ThreadProviderCatalogs = {
  window: codexModelProviderLabels([localCodex]),
  owners: new Map([["peer-1", codexModelProviderLabels([peerCodex])]]),
};

function thread(model: string | undefined, federation?: NavigationThreadSummary["federation"]): NavigationThreadSummary {
  return {
    id: `thread-${model ?? "default"}`,
    title: "Prove the lemma",
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    updatedAt: 1,
    inbox: { inInbox: false },
    linkedDirectories: [],
    ...(model ? { model } : {}),
    ...(federation ? { federation } : {}),
  };
}

function withContexts(providers: readonly AppServerBackendKind[], children: ReactNode) {
  return (
    <ThreadProviderCatalogsContext.Provider value={catalogs}>
      <ThreadProvidersContext.Provider value={providers}>{children}</ThreadProvidersContext.Provider>
    </ThreadProviderCatalogsContext.Provider>
  );
}

describe("a thread on a named Codex model provider", () => {
  it("is named by its provider, not OpenAI, on its row and in its header", () => {
    const mathos = thread("@mathos/gpt-oss-120b");
    const row = render(withContexts(["claude", "codex"], (
      <ThreadRow thread={mathos} onOpenContextMenu={vi.fn()} onSelectThread={vi.fn()} />
    )));
    expect(row.container.querySelector(".thread-row__chip--backend")).toHaveTextContent("MathOS");
    cleanup();
    const header = render(withContexts(["claude", "codex"], <ThreadHeader thread={mathos} />));
    expect(header.container.querySelector(".chip--backend")).toHaveTextContent("MathOS");
  });

  it("keeps its chip when every thread is a Codex thread, because it is not OpenAI", () => {
    const { container } = render(withContexts(["codex"], (
      <ThreadRow thread={thread("@refuseless/gpt-oss-120b")} onOpenContextMenu={vi.fn()} onSelectThread={vi.fn()} />
    )));
    expect(container.querySelector(".thread-row__chip--backend")).toHaveTextContent("Refuseless");
  });

  it("leaves an OpenAI thread named OpenAI, and hidden when it tells no threads apart", () => {
    expect(formatThreadProviderLabel(thread("gpt-oss-120b"), catalogs)).toBe("OpenAI");
    const { container } = render(withContexts(["codex"], (
      <ThreadRow thread={thread("gpt-oss-120b")} onOpenContextMenu={vi.fn()} onSelectThread={vi.fn()} />
    )));
    expect(container.querySelector(".thread-row__chip--backend")).toBeNull();
  });

  it("names a peer's thread from the peer's catalog, and never from this window's", () => {
    const remote = (instanceId: string) => ({
      ref: { target: { scope: "remote" as const, instanceId }, threadId: "t" },
    }) as unknown as NavigationThreadSummary["federation"];
    expect(formatThreadProviderLabel(thread("@mathos/x", remote("peer-1")), catalogs)).toBe("Peer MathOS");
    // A peer whose catalog this window has not read: the id, not the local name.
    expect(formatThreadProviderLabel(thread("@mathos/x", remote("peer-2")), catalogs)).toBe("mathos");
  });
});
