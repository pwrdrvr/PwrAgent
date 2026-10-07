import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentEvent, TrustCodexProjectRequest } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { CodexConfigWarningBanner } from "../CodexConfigWarningBanner";
import { codexWarningSuppressionId } from "../codex-warning-suppression";

function configWarningEvent(params: {
  federationTarget?: AgentEvent["federationTarget"];
  summary: string;
  details?: string;
}): AgentEvent {
  return {
    backend: "codex",
    ...(params.federationTarget
      ? { federationTarget: params.federationTarget }
      : {}),
    notification: {
      method: "configWarning",
      params: {
        summary: params.summary,
        details: params.details ?? null,
        trustedProjectPath: "/remote/repo",
        configPath: "/remote/.codex/config.toml",
      },
    },
  };
}

afterEach(() => {
  delete (window as unknown as {
    __pwragentFederationTarget?: unknown;
  }).__pwragentFederationTarget;
  cleanup();
});

describe("CodexConfigWarningBanner", () => {
  it("waits for saved preferences before loading the latest warning", async () => {
    const getLatestCodexConfigWarning = vi.fn(async () => ({
      event: configWarningEvent({ summary: "Unsupported feature" }),
    }));
    const desktopApi: DesktopApi = { getLatestCodexConfigWarning };
    const view = render(
      <CodexConfigWarningBanner desktopApi={desktopApi} preferencesLoaded={false} />,
    );
    expect(getLatestCodexConfigWarning).not.toHaveBeenCalled();
    view.rerender(
      <CodexConfigWarningBanner desktopApi={desktopApi} preferencesLoaded />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported feature");
  });

  it("persists only the selected warning and suppresses snapshots and live repeats after remount", async () => {
    const warning = configWarningEvent({
      summary: "Ignoring unknown feature requirement",
      details: "Unsupported example_feature",
    });
    let publish: ((event: AgentEvent) => void) | undefined;
    const desktopApi: DesktopApi = {
      getLatestCodexConfigWarning: vi.fn(async () => ({ event: warning })),
      onAgentEvent: (callback) => {
        publish = callback;
        return () => undefined;
      },
    };
    const suppress = vi.fn(async (_id: string) => true);
    const view = render(
      <CodexConfigWarningBanner desktopApi={desktopApi} onSuppressWarning={suppress} />,
    );
    await screen.findByRole("alert");
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Don't show again" }));
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(suppress).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const dismissedWarningIds = [suppress.mock.calls[0][0]];
    view.unmount();
    await act(async () => {
      render(
        <CodexConfigWarningBanner
          desktopApi={desktopApi}
          dismissedWarningIds={dismissedWarningIds}
          onSuppressWarning={suppress}
        />,
      );
    });
    act(() => publish?.(warning));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => publish?.(configWarningEvent({
      summary: "Ignoring unknown feature requirement",
      details: "Unsupported different_feature",
    })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported different_feature");
  });

  it.each(["false", "reject"])("keeps the warning visible when saving returns %s", async (failure) => {
    const suppress = vi.fn(async () => {
      if (failure === "reject") throw new Error("Save failed");
      return false;
    });
    const desktopApi: DesktopApi = {
      getLatestCodexConfigWarning: async () => ({
        event: configWarningEvent({ summary: "Unsupported feature" }),
      }),
    };
    render(<CodexConfigWarningBanner desktopApi={desktopApi} onSuppressWarning={suppress} />);
    await screen.findByRole("alert");
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Don't show again" }));
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save this preference.");
    expect(screen.getByRole("checkbox", { name: "Don't show again" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Don't show again" })).toBeChecked();
  });

  it("keeps the warning open when Don't show again is checked until Dismiss", async () => {
    const suppress = vi.fn(async () => true);
    const desktopApi: DesktopApi = {
      getLatestCodexConfigWarning: async () => ({
        event: configWarningEvent({ summary: "Unsupported feature" }),
      }),
    };
    render(<CodexConfigWarningBanner desktopApi={desktopApi} onSuppressWarning={suppress} />);
    await screen.findByRole("alert");
    const checkbox = screen.getByRole("checkbox", { name: "Don't show again" });

    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Unsupported feature");
    expect(checkbox).toBeChecked();
    expect(suppress).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(checkbox).not.toBeChecked();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(suppress).not.toHaveBeenCalled();
  });

  it("stays hidden when a thread warning toast saved the same text", async () => {
    const desktopApi: DesktopApi = {
      getLatestCodexConfigWarning: async () => ({
        event: configWarningEvent({
          summary: "Unsupported feature",
          details: "Unsupported example_feature",
        }),
      }),
    };
    await act(async () => {
      render(
        <CodexConfigWarningBanner
          desktopApi={desktopApi}
          dismissedWarningIds={[codexWarningSuppressionId({ summary: "Unsupported feature" })]}
        />,
      );
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not persist an ordinary dismissal", async () => {
    const suppress = vi.fn(async () => true);
    const desktopApi: DesktopApi = {
      getLatestCodexConfigWarning: async () => ({
        event: configWarningEvent({ summary: "Unsupported feature" }),
      }),
    };
    const view = render(
      <CodexConfigWarningBanner desktopApi={desktopApi} onSuppressWarning={suppress} />,
    );
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(suppress).not.toHaveBeenCalled();
    view.unmount();
    render(<CodexConfigWarningBanner desktopApi={desktopApi} onSuppressWarning={suppress} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported feature");
  });

  it("ignores remote warnings in a local controller window", async () => {
    let publish: ((event: AgentEvent) => void) | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        publish = callback;
        return () => undefined;
      },
    };
    render(<CodexConfigWarningBanner desktopApi={desktopApi} />);
    await waitFor(() => expect(publish).toBeDefined());

    publish?.(configWarningEvent({
      federationTarget: {
        scope: "remote",
        instanceId: "remote-instance",
      },
      summary: "Remote warning",
    }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows only warnings from the remote window's selected instance", async () => {
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "selected-instance",
    };
    let publish: ((event: AgentEvent) => void) | undefined;
    const trustCodexProject = vi.fn(async (request: TrustCodexProjectRequest) => ({
      ...request,
      trusted: true,
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        publish = callback;
        return () => undefined;
      },
      trustCodexProject,
    };
    render(<CodexConfigWarningBanner desktopApi={desktopApi} />);
    await waitFor(() => expect(publish).toBeDefined());

    publish?.(configWarningEvent({
      federationTarget: {
        scope: "remote",
        instanceId: "other-instance",
      },
      summary: "Other warning",
    }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => {
      publish?.(configWarningEvent({
        federationTarget: {
          scope: "remote",
          instanceId: "selected-instance",
        },
        summary: "Selected warning",
      }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Selected warning",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trust repo" }));
    });
    await waitFor(() => {
      expect(trustCodexProject).toHaveBeenCalledWith({
        federationTarget: {
          scope: "remote",
          instanceId: "selected-instance",
        },
        projectPath: "/remote/repo",
        configPath: "/remote/.codex/config.toml",
      });
    });
  });
});
