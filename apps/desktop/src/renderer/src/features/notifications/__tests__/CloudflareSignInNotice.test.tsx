import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEDERATION_HEALTH_CHANGED_METHOD,
  type AgentEvent,
  type CloudflareSetupStatus,
  type FederationHealthStatus,
  type ReadFederationHealthResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useFederationHealth } from "../../../lib/useFederationHealth";
import { AppNoticeToast, type AppNoticeToastNotice } from "../AppNoticeToast";
import { CloudflareSignInNotice } from "../CloudflareSignInNotice";

afterEach(cleanup);

const endpoint = "wss://federation.example.com";
const required: FederationHealthStatus = {
  enabled: true, role: "client", status: "rejected", peers: [],
  cloudflareSignInRequired: { endpoint },
};
const signedIn: CloudflareSetupStatus = {
  connected: false, connectorInstalled: false, connectorRunning: false, clients: [],
  signIn: { endpoint, state: "signed-in" },
};
const healthy: FederationHealthStatus = { enabled: true, role: "client", status: "connected", peers: [] };
function noop(): void {}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function NoticeHarness(props: {
  health?: FederationHealthStatus;
  desktopApi: Pick<DesktopApi, "configureFederationCloudflare">;
  onRefreshHealth?: () => void;
}) {
  const [notice, setNotice] = useState<AppNoticeToastNotice>();
  return <>
    <CloudflareSignInNotice {...props} onNoticeChanged={setNotice} onRefreshHealth={props.onRefreshHealth ?? noop} />
    <AppNoticeToast notice={notice} onDismiss={noop} />
  </>;
}

describe("Cloudflare sign-in recovery notice", () => {
  it("opens sign-in from a persistent toast, prevents duplicate launches, and clears after success", async () => {
    const result = deferred<CloudflareSetupStatus>();
    const configure = vi.fn(() => result.promise);
    const refresh = vi.fn();
    render(<NoticeHarness health={required} desktopApi={{ configureFederationCloudflare: configure }} onRefreshHealth={refresh} />);
    expect(screen.getByRole("status")).toHaveTextContent("Cloudflare Access needs sign-in");
    expect(document.querySelector(".app-notice-toast__timer")).not.toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Sign in" });
    act(() => { start.click(); start.click(); });
    expect(configure).toHaveBeenCalledExactlyOnceWith({ action: "sign-in" });
    expect(screen.getByRole("status")).toHaveTextContent("Finish signing in in your browser");
    await act(async () => result.resolve(signedIn));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows failed sign-in details and lets the user retry", async () => {
    const configure = vi.fn().mockRejectedValueOnce(new Error("Browser sign-in timed out."))
      .mockResolvedValueOnce(signedIn);
    render(<NoticeHarness health={required} desktopApi={{ configureFederationCloudflare: configure }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    expect(screen.getByRole("status")).toHaveTextContent("Browser sign-in timed out.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry sign-in" })));
    expect(configure).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("can reopen or cancel a pending browser flow without treating cancellation as success", async () => {
    const result = deferred<CloudflareSetupStatus>();
    const cancelled = { ...signedIn, signIn: { endpoint, state: "sign-in-required" as const } };
    const configure = vi.fn(async (request) => {
      if (request.action === "sign-in") return result.promise;
      if (request.action === "cancel-sign-in") result.resolve(cancelled);
      return cancelled;
    });
    render(<NoticeHarness health={required} desktopApi={{ configureFederationCloudflare: configure }} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open browser again" })));
    expect(configure).toHaveBeenLastCalledWith({ action: "reopen-sign-in" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" })));
    expect(configure).toHaveBeenLastCalledWith({ action: "cancel-sign-in" });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("keeps a dismissal through repeated health updates and prompts for a later incident", () => {
    const desktopApi = { configureFederationCloudflare: vi.fn(async () => signedIn) };
    const view = render(<NoticeHarness health={required} desktopApi={desktopApi} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    view.rerender(<NoticeHarness health={{ ...required }} desktopApi={desktopApi} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<NoticeHarness health={healthy} desktopApi={desktopApi} />);
    view.rerender(<NoticeHarness health={required} desktopApi={desktopApi} />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("does not offer sign-in for ordinary transport errors or disabled Federation", () => {
    const desktopApi = { configureFederationCloudflare: vi.fn(async () => signedIn) };
    const view = render(<NoticeHarness health={{ ...healthy, status: "connecting", unavailableReason: "Network timeout" }} desktopApi={desktopApi} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<NoticeHarness health={{ ...required, enabled: false }} desktopApi={desktopApi} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("ignores completion from a sign-in for an endpoint that has changed", async () => {
    const result = deferred<CloudflareSetupStatus>();
    const desktopApi = { configureFederationCloudflare: vi.fn(() => result.promise) };
    const refresh = vi.fn();
    const view = render(<NoticeHarness health={required} desktopApi={desktopApi} onRefreshHealth={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    view.rerender(<NoticeHarness health={{ ...required, cloudflareSignInRequired: { endpoint: "wss://other.example.com" } }} desktopApi={desktopApi} onRefreshHealth={refresh} />);
    await act(async () => result.resolve(signedIn));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("wss://other.example.com");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes local authentication health without peers and ignores an older mount snapshot", async () => {
    let emit!: (event: AgentEvent) => void;
    const first = deferred<ReadFederationHealthResponse>();
    const unsubscribe = vi.fn();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ health: required });
    const desktopApi = {
      readFederationHealth: read,
      onAgentEvent: (listener: (event: AgentEvent) => void) => { emit = listener; return unsubscribe; },
    };
    const view = renderHook(() => useFederationHealth({ desktopApi }));
    await act(async () => {});
    await act(async () => emit({ backend: "codex", notification: { method: FEDERATION_HEALTH_CHANGED_METHOD, params: {} } }));
    expect(view.result.current.health?.cloudflareSignInRequired).toEqual({ endpoint });
    await act(async () => first.resolve({ health: healthy }));
    expect(view.result.current.health?.cloudflareSignInRequired).toEqual({ endpoint });
    act(() => emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "pwr_other" }, notification: { method: FEDERATION_HEALTH_CHANGED_METHOD, params: {} } }));
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
