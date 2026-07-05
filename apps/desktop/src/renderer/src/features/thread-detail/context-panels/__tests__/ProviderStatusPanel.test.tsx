import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import { ProviderStatusPanel } from "../ProviderStatusPanel";

afterEach(() => {
  cleanup();
});

const codexBackend: BackendSummary = {
  kind: "codex",
  label: "Codex app server",
  available: true,
  account: {
    type: "chatgpt",
    email: "user@example.com",
    planType: "pro",
    requiresOpenaiAuth: false,
  },
  methods: ["thread/list", "thread/read"],
  capabilities: {
    listThreads: true,
    createThread: false,
    resumeThread: true,
    renameThread: false,
    readThread: true,
    startTurn: true,
    interruptTurn: false,
    steerTurn: false,
    transcriptPagination: true,
    toolUse: false,
    approvalRequests: false,
    multiDirectoryThreads: true,
  },
  executionModes: [
    { mode: "default", label: "Default", available: true, isDefault: true },
  ],
  rateLimits: [
    { name: "5h limit", usedPercent: 15, windowMinutes: 300 },
    { name: "Weekly limit", usedPercent: 9, windowMinutes: 10_080 },
  ],
};

const grokBackend: BackendSummary = {
  kind: "grok",
  label: "Grok app server",
  available: false,
  methods: [],
  capabilities: {
    listThreads: false,
    createThread: false,
    resumeThread: false,
    renameThread: false,
    readThread: false,
    startTurn: false,
    interruptTurn: false,
    steerTurn: false,
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: false,
    multiDirectoryThreads: false,
  },
  executionModes: [],
  unavailableReason: "XAI_API_KEY is not set",
};

describe("ProviderStatusPanel", () => {
  it("renders account, plan, and rate limits for an available backend", () => {
    render(<ProviderStatusPanel backends={[codexBackend]} />);

    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("pro")).toBeInTheDocument();
    expect(screen.getByText(/5h limit: 85% left/)).toBeInTheDocument();
    expect(screen.getByText(/Weekly limit: 91% left/)).toBeInTheDocument();
  });

  it("shows the unavailable reason for an offline backend", () => {
    render(<ProviderStatusPanel backends={[grokBackend]} />);

    expect(screen.getByText("Grok app server")).toBeInTheDocument();
    expect(screen.getByText("XAI_API_KEY is not set")).toBeInTheDocument();
  });

  it("renders a backend error when status is unavailable", () => {
    render(
      <ProviderStatusPanel
        backends={[]}
        backendError="App servers unreachable"
      />,
    );

    expect(screen.getByText("App servers unreachable")).toBeInTheDocument();
  });

  it("renders an empty state when no backends and no error", () => {
    render(<ProviderStatusPanel backends={[]} />);

    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  });
});
