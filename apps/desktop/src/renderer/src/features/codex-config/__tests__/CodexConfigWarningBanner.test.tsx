import "@testing-library/jest-dom/vitest";
import {
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

describe("CodexConfigWarningBanner", () => {
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

    publish?.(configWarningEvent({
      federationTarget: {
        scope: "remote",
        instanceId: "selected-instance",
      },
      summary: "Selected warning",
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Selected warning",
    );
    fireEvent.click(screen.getByRole("button", { name: "Trust repo" }));
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
