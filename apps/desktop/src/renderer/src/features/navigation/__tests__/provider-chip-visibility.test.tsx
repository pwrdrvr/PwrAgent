import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind, NavigationThreadSummary } from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";
import { ThreadHeader } from "../../thread-detail/ThreadHeader";
import { ThreadPlaceholderHeader } from "../../thread-detail/ThreadPlaceholderHeader";
import {
  ThreadProvidersContext,
  providerChipNeeded,
} from "../provider-chip-visibility";

afterEach(() => {
  cleanup();
});

const codexThread: NavigationThreadSummary = {
  id: "thread-provider-chip",
  title: "Refactor crate-grpc",
  titleSource: "explicit",
  source: "codex",
  executionMode: "default",
  updatedAt: Date.now(),
  inbox: { inInbox: false },
  linkedDirectories: [],
};

function withProviders(
  providers: readonly AppServerBackendKind[] | undefined,
  children: ReactNode,
) {
  return (
    <ThreadProvidersContext.Provider value={providers}>
      {children}
    </ThreadProvidersContext.Provider>
  );
}

function renderRow(providers: readonly AppServerBackendKind[] | undefined) {
  return render(withProviders(providers, (
    <ThreadRow
      thread={codexThread}
      onOpenContextMenu={vi.fn()}
      onSelectThread={vi.fn()}
    />
  )));
}

describe("providerChipNeeded", () => {
  it("shows the chip while the provider list is unknown", () => {
    expect(providerChipNeeded(undefined, "codex")).toBe(true);
  });

  it("hides the chip when every thread uses the same provider", () => {
    expect(providerChipNeeded(["codex"], "codex")).toBe(false);
  });

  it("shows the chip once threads span more than one provider", () => {
    expect(providerChipNeeded(["claude", "codex"], "codex")).toBe(true);
    expect(providerChipNeeded(["claude", "codex"], "claude")).toBe(true);
  });

  it("shows the chip for a provider no thread uses yet", () => {
    // A launchpad set to Claude while every thread so far is OpenAI.
    expect(providerChipNeeded(["codex"], "claude")).toBe(true);
  });

  it("hides the chip before any thread exists", () => {
    expect(providerChipNeeded([], "codex")).toBe(false);
  });
});

describe("provider chip on thread rows", () => {
  it("drops the provider chip when only one provider has threads", () => {
    const { container } = renderRow(["codex"]);

    expect(container.querySelector(".thread-row__chip--backend")).toBeNull();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
  });

  it("keeps the provider chip when threads span providers", () => {
    const { container } = renderRow(["claude", "codex"]);

    expect(container.querySelector(".thread-row__chip--backend")).toHaveTextContent("OpenAI");
  });

  it("keeps the provider chip when no provider list is available", () => {
    const { container } = renderRow(undefined);

    expect(container.querySelector(".thread-row__chip--backend")).toHaveTextContent("OpenAI");
  });
});

describe("provider chip in the thread header", () => {
  it("drops the provider chip when only one provider has threads", () => {
    const { container } = render(withProviders(["codex"], <ThreadHeader thread={codexThread} />));

    expect(container.querySelector(".chip--backend")).toBeNull();
  });

  it("keeps the provider chip when threads span providers", () => {
    const { container } = render(
      withProviders(["claude", "codex"], <ThreadHeader thread={codexThread} />),
    );

    expect(container.querySelector(".chip--backend")).toHaveTextContent("OpenAI");
  });
});

describe("provider chip in the launchpad header", () => {
  it("drops the chip when the launchpad uses the only provider with threads", () => {
    const { container } = render(withProviders(["codex"], (
      <ThreadPlaceholderHeader backend="codex" backendLabel="OpenAI" title="New thread" />
    )));

    expect(container.querySelector(".chip--backend")).toBeNull();
  });

  it("keeps the chip when the launchpad uses a provider no thread uses yet", () => {
    const { container } = render(withProviders(["codex"], (
      <ThreadPlaceholderHeader backend="claude" backendLabel="Claude" title="New thread" />
    )));

    expect(container.querySelector(".chip--backend")).toHaveTextContent("Claude");
  });
});
