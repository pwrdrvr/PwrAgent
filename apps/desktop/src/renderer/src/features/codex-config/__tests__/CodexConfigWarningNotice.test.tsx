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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  AppNoticeToast,
  type AppNoticeToastNotice,
} from "../../notifications/AppNoticeToast";
import { CodexConfigWarningNotice } from "../CodexConfigWarningNotice";

/** The producer and the card the host draws its notice in, as App wires them. */
function Host(props: { desktopApi: DesktopApi }) {
  const [notice, setNotice] = useState<AppNoticeToastNotice>();
  return (
    <>
      <CodexConfigWarningNotice
        desktopApi={props.desktopApi}
        onNoticeChanged={setNotice}
      />
      <AppNoticeToast notice={notice} onDismiss={() => setNotice(undefined)} />
    </>
  );
}

function configWarningEvent(params: {
  federationTarget?: AgentEvent["federationTarget"];
  summary: string;
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
        details: null,
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

describe("CodexConfigWarningNotice", () => {
  it("ignores remote warnings in a local controller window", async () => {
    let publish: ((event: AgentEvent) => void) | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        publish = callback;
        return () => undefined;
      },
    };
    render(<Host desktopApi={desktopApi} />);
    await waitFor(() => expect(publish).toBeDefined());

    publish?.(configWarningEvent({
      federationTarget: {
        scope: "remote",
        instanceId: "remote-instance",
      },
      summary: "Remote warning",
    }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
    render(<Host desktopApi={desktopApi} />);
    await waitFor(() => expect(publish).toBeDefined());

    publish?.(configWarningEvent({
      federationTarget: {
        scope: "remote",
        instanceId: "other-instance",
      },
      summary: "Other warning",
    }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => {
      publish?.(configWarningEvent({
        federationTarget: {
          scope: "remote",
          instanceId: "selected-instance",
        },
        summary: "Selected warning",
      }));
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
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

  it("draws the warning in the shared notice card and keeps it closed", async () => {
    let publish: ((event: AgentEvent) => void) | undefined;
    let resolveTrust: (() => void) | undefined;
    const trustCodexProject = vi.fn((request: TrustCodexProjectRequest) =>
      new Promise<TrustCodexProjectRequest & { trusted: boolean }>((resolve) => {
        resolveTrust = () => resolve({ ...request, trusted: true });
      })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        publish = callback;
        return () => undefined;
      },
      trustCodexProject,
    };
    render(<Host desktopApi={desktopApi} />);
    await waitFor(() => expect(publish).toBeDefined());

    act(() => {
      publish?.(configWarningEvent({ summary: "Untrusted project" }));
    });
    const card = await screen.findByRole("status");
    expect(card).toHaveClass("app-notice-toast");
    expect(card).toHaveAttribute("data-tone", "warning");
    expect(card).toHaveTextContent("Codex config warning");
    // The card's own close; the feature draws no Dismiss of its own.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    // Trusting runs once: the action holds itself disabled until it settles.
    fireEvent.click(screen.getByRole("button", { name: "Trust repo" }));
    expect(screen.getByRole("button", { name: "Trusting..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Trusting..." }));
    expect(trustCodexProject).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveTrust?.();
    });
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    // Closing one warning keeps that warning closed when it repeats.
    act(() => {
      publish?.(configWarningEvent({ summary: "Second warning" }));
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Second warning");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    act(() => {
      publish?.(configWarningEvent({ summary: "Second warning" }));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
