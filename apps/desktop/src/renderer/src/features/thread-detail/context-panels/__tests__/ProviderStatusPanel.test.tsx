import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import { ProviderStatusPanel } from "../ProviderStatusPanel";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../../lib/useBackendSummaries";

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
    {
      name: "Credits",
      limitId: "credits",
      windowKey: "credits",
      hasCredits: true,
      remaining: 100,
    },
  ],
};

const grokBackend: BackendSummary = {
  kind: "acp:grok",
  label: "Grok",
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
  unavailableReason: "Grok CLI is not installed",
};

const kimiBackend: BackendSummary = {
  ...codexBackend,
  kind: "acp:kimi",
  source: "acp",
  label: "Kimi",
  account: undefined,
  rateLimits: undefined,
  acp: {
    registryId: "kimi",
    version: "0.29.2",
    distributionKinds: ["local"],
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
  },
};

const grokAcpBackend: BackendSummary = {
  ...codexBackend,
  kind: "acp:grok",
  source: "acp",
  label: "Grok",
  account: {
    type: "provider",
    label: "Grok account",
    planType: "SuperGrok Heavy",
  },
  rateLimits: [
    {
      name: "Included credits",
      usedPercent: 42.5,
    },
  ],
  acp: {
    registryId: "grok",
    version: "0.2.112",
    distributionKinds: ["local"],
    installStatus: "installed",
    authStatus: "authenticated",
    verificationStatus: "not-applicable",
  },
};

describe("ProviderStatusPanel", () => {
  it("refreshes account usage whenever the provider tab opens", () => {
    const onRefresh = vi.fn();
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefresh, {
      once: true,
    });

    render(<ProviderStatusPanel backends={[]} />);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("names the version and publisher of the Codex runtime in effect", () => {
    render(
      <ProviderStatusPanel
        backends={[
          {
            ...codexBackend,
            runtimeBuild: { channel: "vendor", publisher: "OpenAI" },
            serverVersion: "0.149.1",
          },
        ]}
      />,
    );

    expect(screen.getByText("0.149.1")).toBeInTheDocument();
    expect(screen.getByText("OpenAI release")).toBeInTheDocument();
  });

  it("names a PwrDrvr build rather than leaving it to the version suffix", () => {
    // `0.149.0-pwragent.2` is the only thing separating this from OpenAI's
    // 0.149.0, and a suffix alone reads as noise.
    render(
      <ProviderStatusPanel
        backends={[
          {
            ...codexBackend,
            runtimeBuild: { channel: "pwragent", publisher: "PwrDrvr" },
            serverVersion: "0.149.0-pwragent.2",
          },
        ]}
      />,
    );

    expect(screen.getByText("0.149.0-pwragent.2")).toBeInTheDocument();
    expect(screen.getByText("PwrDrvr build")).toBeInTheDocument();
  });

  it("renders account, plan, and rate limits for an available backend", () => {
    render(<ProviderStatusPanel backends={[codexBackend]} />);

    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("pro")).toBeInTheDocument();
    expect(screen.getByText(/Credits: 100/)).toBeInTheDocument();
    expect(screen.getByText(/5h limit: 85% left/)).toBeInTheDocument();
    expect(screen.getByText(/Weekly limit: 91% left/)).toBeInTheDocument();
  });

  it("shows the unavailable reason for an offline backend", () => {
    render(<ProviderStatusPanel backends={[grokBackend]} />);

    expect(screen.getByText("Grok")).toBeInTheDocument();
    expect(screen.getByText("Grok CLI is not installed")).toBeInTheDocument();
  });

  it("shows ACP runtime and authentication metadata without a limits API", () => {
    render(<ProviderStatusPanel backends={[kimiBackend]} />);

    expect(screen.getByRole("heading", { name: "AI providers" })).toBeInTheDocument();
    expect(screen.getByText("0.29.2")).toBeInTheDocument();
    expect(screen.getByText("Managed by provider")).toBeInTheDocument();
  });

  it("shows the owning-instance credential boundary for managed Claude", () => {
    render(
      <ProviderStatusPanel
        backends={[
          {
            ...kimiBackend,
            kind: "acp:claude-acp",
            label: "Claude Agent",
            acp: {
              ...kimiBackend.acp!,
              registryId: "claude-acp",
              authStatus: "authenticated",
              credentialScope: "owning-instance",
              supportLevel: "experimental",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Owning instance only")).toBeInTheDocument();
    expect(screen.getByText("Experimental")).toBeInTheDocument();
  });

  it("shows Grok subscription and included-credit usage from ACP billing", () => {
    render(<ProviderStatusPanel backends={[grokAcpBackend]} />);

    expect(screen.getByText("Grok account")).toBeInTheDocument();
    expect(screen.getByText("SuperGrok Heavy")).toBeInTheDocument();
    expect(screen.getByText(/Included credits: 58% left/)).toBeInTheDocument();
  });

  it("renders a backend error when status is unavailable", () => {
    render(<ProviderStatusPanel backends={[]} backendError="App servers unreachable" />);

    expect(screen.getByText("App servers unreachable")).toBeInTheDocument();
  });

  it("renders an empty state when no backends and no error", () => {
    render(<ProviderStatusPanel backends={[]} />);

    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  });
});
