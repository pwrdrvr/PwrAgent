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
    expect(screen.getByRole("status")).toHaveTextContent("Federation reconnects when you finish signing in.");
    await act(async () => result.resolve(signedIn));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("names a failed sign-in, makes its reason the message, and lets the user retry", async () => {
    const configure = vi.fn().mockRejectedValueOnce(new Error("Browser sign-in timed out."))
      .mockResolvedValueOnce(signedIn);
    render(<NoticeHarness health={required} desktopApi={{ configureFederationCloudflare: configure }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    expect(document.querySelector(".app-notice-toast__title")).toHaveTextContent("Cloudflare sign-in failed");
    expect(document.querySelector(".app-notice-toast__message")).toHaveTextContent("Browser sign-in timed out.");
    expect(screen.getByRole("status")).not.toHaveTextContent("Federation is disconnected");
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

  it("shows a sign-in another window started as waiting, with working controls", async () => {
    const configure = vi.fn().mockRejectedValueOnce(new Error("Browser sign-in timed out."))
      .mockResolvedValue(signedIn);
    const desktopApi = { configureFederationCloudflare: configure };
    const view = render(<NoticeHarness health={required} desktopApi={desktopApi} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    view.rerender(<NoticeHarness health={{ ...required, cloudflareSignInRequired: { endpoint, pending: true } }} desktopApi={desktopApi} />);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for browser sign-in");
    expect(screen.getByRole("status")).not.toHaveTextContent("Browser sign-in timed out.");
    expect(screen.queryByRole("button", { name: /Sign in$/ })).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" })));
    expect(configure).toHaveBeenLastCalledWith({ action: "cancel-sign-in" });
    view.rerender(<NoticeHarness health={required} desktopApi={desktopApi} />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("asks for a sign-in before the grant ends, and a dismissed warning does not hide the expiry", async () => {
    const expiresAt = "2026-10-09T15:30:00.000Z";
    const expiring: FederationHealthStatus = {
      enabled: true, role: "client", status: "connected", peers: [],
      cloudflareSignInExpiring: { endpoint, expiresAt },
    };
    const configure = vi.fn(async () => signedIn);
    const desktopApi = { configureFederationCloudflare: configure };
    const view = render(<NoticeHarness health={expiring} desktopApi={desktopApi} />);
    expect(document.querySelector(".app-notice-toast__title")).toHaveTextContent("Cloudflare sign-in expires soon");
    expect(screen.getByRole("status")).toHaveTextContent("Sign in again now to keep Federation connected");
    const facts = [...document.querySelectorAll(".app-notice-toast__fact dt")].map((term) => term.textContent);
    expect(facts).toEqual(["Expires", "Endpoint"]);
    expect(document.querySelector(".app-notice-toast__timer")).not.toBeInTheDocument();
    view.rerender(<NoticeHarness health={{ ...expiring, cloudflareSignInExpiring: { endpoint, expiresAt, pending: true } }} desktopApi={desktopApi} />);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for browser sign-in");
    view.rerender(<NoticeHarness health={expiring} desktopApi={desktopApi} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
    expect(configure).toHaveBeenCalledExactlyOnceWith({ action: "sign-in" });
    view.rerender(<NoticeHarness health={{ ...expiring }} desktopApi={desktopApi} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // Dismissing the warning is not dismissing the expiry it warned about.
    view.rerender(<NoticeHarness health={required} desktopApi={desktopApi} />);
    expect(document.querySelector(".app-notice-toast__title")).toHaveTextContent("Cloudflare Access needs sign-in");
  });

  it("dismisses an early warning without hiding the expiry that follows", () => {
    const expiring: FederationHealthStatus = {
      enabled: true, role: "client", status: "connected", peers: [],
      cloudflareSignInExpiring: { endpoint, expiresAt: "2026-10-09T15:30:00.000Z" },
    };
    const desktopApi = { configureFederationCloudflare: vi.fn(async () => signedIn) };
    const view = render(<NoticeHarness health={expiring} desktopApi={desktopApi} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    view.rerender(<NoticeHarness health={{ ...expiring }} desktopApi={desktopApi} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<NoticeHarness health={required} desktopApi={desktopApi} />);
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
