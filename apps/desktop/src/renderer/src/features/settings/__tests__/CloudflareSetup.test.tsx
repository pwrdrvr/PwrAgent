import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { CloudflareSetup } from "../CloudflareSetup";
import type { CloudflareSetupRequest, CloudflareSetupStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";

const connected: CloudflareSetupStatus = {
  connected: true, zoneName: "example.com", connectorInstalled: true,
  connectorRunning: false, clients: [],
};

describe("Cloudflare setup flow", () => {
  it("enables loopback ownership before provisioning and preserves an existing client role", async () => {
    const events: string[] = [];
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action !== "status") events.push(request.action);
      return connected;
    });
    const write = vi.fn(async () => { events.push("bind"); return true; });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" mode="client" onWriteConfig={write} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await waitFor(() => expect(events).toEqual(["bind", "provision"]));
    expect(write).toHaveBeenCalledWith({ federation: { mode: "dual", listenHost: "127.0.0.1", listenPort: 47830 } });
  });

  it("does not provision when enabling the listener fails", async () => {
    const call = vi.fn(async (_request: CloudflareSetupRequest) => connected);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => false} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await screen.findByRole("alert");
    expect(call.mock.calls.every((args) => (args[0] as { action: string })?.action === "status")).toBe(true);
  });

  it("shows failed security evidence and requires an installed connector and API connection", async () => {
    const call = vi.fn(async () => ({ ...connected, tunnelId: "tunnel", hostname: "federation.example.com", phase: "Published",
      checks: [{ label: "WebSocket upgrade without certificate", passed: false, detail: "The request reached the gateway." }] }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("FAIL");
    expect(screen.getByRole("button", { name: "Validate Endpoint Security" })).toBeDisabled();
    expect(screen.getByText("The request reached the gateway.")).toBeInTheDocument();
  });

  it("names the product, discloses the plan requirement, and opens reference links", async () => {
    const call = vi.fn(async (_request: CloudflareSetupRequest) => connected);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    // The pane has to name Access mTLS: two different Cloudflare products are
    // called mTLS and only one of them is what this provisions.
    // mTLS is not the default any more, so its plan warning must appear only
    // when the operator actually selects that gate.
    expect(screen.queryByText(/Confirmed unavailable on the Free plan/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Client certificate/ }));
    expect(screen.getByText(/Confirmed unavailable on the Free plan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Mutual TLS in the dashboard" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "open-link", link: "dash-mtls" }));
  });

  it("keeps reference links usable while an operation is running", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "provision") await gate;
      return connected;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    // Select mTLS so its plan notice — and the reference links inside it — render.
    fireEvent.click(screen.getByRole("radio", { name: /Client certificate/ }));
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await screen.findByText("Creating CA, Access policy, and tunnel…");
    // Reading the docs is exactly what an operator does while provisioning runs.
    expect(screen.getByRole("button", { name: "Access mTLS documentation" })).toBeEnabled();
    release();
  });
  it("defaults to service tokens and provisions with that gate", async () => {
    const events: CloudflareSetupRequest[] = [];
    const call = vi.fn(async (request: CloudflareSetupRequest) => { events.push(request); return connected; });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    expect(screen.getByRole("radio", { name: /Service token/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await waitFor(() => expect(events.some((event) => event.action === "provision")).toBe(true));
    expect(events.find((event) => event.action === "provision")).toMatchObject({ gate: "service-token" });
  });

  it("locks the gate once an endpoint reports one", async () => {
    const call = vi.fn(async () => ({ ...connected, gate: "mtls" as const, tunnelId: "tunnel",
      hostname: "federation.example.com", phase: "Published" }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    // The Access policy and every issued credential are built around the gate,
    // so a provisioned endpoint must not offer to switch it.
    await waitFor(() => expect(screen.getByRole("radio", { name: /Client certificate/ })).toBeChecked());
    expect(screen.getByRole("radio", { name: /Service token/ })).toBeDisabled();
    expect(screen.getByText(/Changing how clients get in means recreating it/)).toBeInTheDocument();
  });

  it("saves a partial draft without connecting, validating, or enabling anything", async () => {
    const events: CloudflareSetupRequest[] = [];
    const empty: CloudflareSetupStatus = { connected: false, connectorInstalled: false, connectorRunning: false, clients: [] };
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      events.push(request);
      return request.action === "save-draft" ? { ...empty, draft: request.draft, message: "Draft saved." } : empty;
    });
    const write = vi.fn(async () => true);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={write} onSettingsChanged={async () => {}} />);
    const account = await screen.findByLabelText("Cloudflare account ID");
    // Nothing typed yet: no draft to save, and no nagging about what is missing.
    expect(screen.getAllByRole("button", { name: "Save draft" })[0]).toBeDisabled();
    expect(screen.queryByText(/Incomplete\./)).toBeNull();

    fireEvent.change(account, { target: { value: "not-even-an-id" } });
    // The draft names what is still needed, in words, before anything is saved.
    expect(screen.getByText(/Incomplete\./).parentElement).toHaveTextContent(
      "Still needed: Zone ID, API token, cloudflared, public hostname.");
    expect(screen.getByRole("button", { name: "Connect Cloudflare" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create protected endpoint" })).toBeDisabled();

    fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[0]);
    await screen.findByText("Draft saved.");
    expect(events.filter((event) => event.action !== "status")).toEqual([
      { action: "save-draft", draft: { accountId: "not-even-an-id", zoneId: "", hostname: "", gate: "service-token", emails: undefined } },
    ]);
    // Saving a draft never touches the federation listener.
    expect(write).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Save draft" })[0]).toBeDisabled();
  });

  it("restores a saved draft as the starting point", async () => {
    const call = vi.fn(async () => ({ connected: false, connectorInstalled: true, connectorRunning: false, clients: [],
      draft: { accountId: "a".repeat(32), zoneId: "b".repeat(32), hostname: "federation.example.com", gate: "oauth" as const, emails: ["me@example.com"] } }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Cloudflare account ID")).toHaveValue("a".repeat(32)));
    expect(screen.getByRole("radio", { name: /Sign in with an identity/ })).toBeChecked();
    expect(screen.getByLabelText("People who can sign in")).toHaveValue("me@example.com");
    // Unchanged since it was saved.
    expect(screen.getAllByRole("button", { name: "Save draft" })[0]).toBeDisabled();
    expect(screen.getByText(/Incomplete\./).parentElement).toHaveTextContent("Still needed: API token.");
  });

  it("marks exactly one stage as the current step", async () => {
    const call = vi.fn(async () => ({ ...connected, connectorInstalled: false }));
    const { container } = render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("Connected · example.com");
    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    // Connected, so the next thing to do is install the connector.
    expect(current[0]).toHaveTextContent("Tunnel connector");
    expect(current[0]).toHaveTextContent("Next");
  });

  it("provisions a sign-in endpoint with its allowlist", async () => {
    const events: CloudflareSetupRequest[] = [];
    const call = vi.fn(async (request: CloudflareSetupRequest) => { events.push(request); return connected; });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.click(screen.getByRole("radio", { name: /Sign in with an identity/ }));
    expect(screen.getByText(/Cloudflare marks Beta/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    // An endpoint nobody may sign in to is not a setup, so it cannot be created.
    expect(screen.getByRole("button", { name: "Create protected endpoint" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("People who can sign in"), { target: { value: "me@example.com, you@example.com\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await waitFor(() => expect(events.some((event) => event.action === "provision")).toBe(true));
    expect(events.find((event) => event.action === "provision")).toMatchObject({
      gate: "oauth", emails: ["me@example.com", "you@example.com"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Open login methods in the dashboard" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "open-link", link: "dash-login-methods" }));
  });

  it("says what creating the endpoint changes in the federation listener", async () => {
    const call = vi.fn(async () => connected);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" listenHost="0.0.0.0" mode="client" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    const statement = screen.getByText(/Creating the endpoint first saves/);
    expect(statement).toHaveTextContent("127.0.0.1:47830");
    expect(statement).toHaveTextContent("changes from client to dual");
    expect(statement).toHaveTextContent("moves from 0.0.0.0 to 127.0.0.1");
  });

  it("passes the chosen invite lifetime when issuing a client", async () => {
    const events: CloudflareSetupRequest[] = [];
    const published = { ...connected, gate: "service-token" as const, tunnelId: "t", hostname: "federation.example.com", phase: "Published" };
    const call = vi.fn(async (request: CloudflareSetupRequest) => { events.push(request); return published; });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare client name");
    fireEvent.change(screen.getByLabelText("Cloudflare client name"), { target: { value: "Travel laptop" } });
    fireEvent.change(screen.getByLabelText("Cloudflare client transfer password"), { target: { value: "long-enough-password" } });
    fireEvent.change(screen.getByLabelText("Invite lifetime"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue & save client setup" }));
    await waitFor(() => expect(events.some((event) => event.action === "export-client")).toBe(true));
    expect(events.find((event) => event.action === "export-client")).toMatchObject({ inviteTtlHours: 24, label: "Travel laptop" });
  });

  it("offers sign-in when a client's Cloudflare grant has lapsed, and can cancel it", async () => {
    let finish = () => {};
    const events: string[] = [];
    const lapsed: CloudflareSetupStatus = { connected: false, connectorInstalled: false, connectorRunning: false, clients: [],
      signIn: { endpoint: "wss://federation.example.com", state: "sign-in-required", signedInAt: "2026-09-01T00:00:00Z",
        lastError: "Your Cloudflare sign-in expired or no longer passes the Access policy." } };
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      events.push(request.action);
      if (request.action === "sign-in") await new Promise<void>((resolve) => { finish = resolve; });
      return lapsed;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    // A client-only instance opens on the half it uses, and says why it is stuck.
    expect(await screen.findByText("Sign-in required.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect this client" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Sign-in required").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(events).toContain("cancel-sign-in"));
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());
  });

  it("keeps manual credentials inside the one Cloudflare section", async () => {
    const call = vi.fn(async () => connected);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}}
      manual={<label>Manual endpoint field</label>} manualConfigured />);
    await screen.findByLabelText("Cloudflare public hostname");
    expect(screen.getByText("Enter Cloudflare credentials manually")).toBeInTheDocument();
    expect(screen.getByText("Manual endpoint field")).toBeInTheDocument();
  });

  it("fills in the conventional hostname once the zone is known", async () => {
    const call = vi.fn(async (_request: CloudflareSetupRequest) => connected);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    // A placeholder read as already filled in while Create stayed disabled.
    await waitFor(() => expect(screen.getByLabelText("Cloudflare public hostname")).toHaveValue("federation.example.com"));
    expect(screen.getByRole("button", { name: "Create protected endpoint" })).toBeEnabled();
  });

  it("lists what a stopped creation left and offers to resume on the moved port or start over", async () => {
    const stopped: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      tunnelId: "tunnel", phase: "Setup incomplete — resume creation",
      resources: ["1 service token", "Access application", "Service Auth policy", "Tunnel"] };
    const call = vi.fn(async (_request: CloudflareSetupRequest) => stopped);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47831" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("Creation stopped before the endpoint was published.");
    expect(screen.getByText(/Created in Cloudflare so far: 1 service token, Access application, Service Auth policy, Tunnel\./)).toBeInTheDocument();
    expect(screen.getByText(/set up for 127\.0\.0\.1:47830; the gateway listener is now 47831/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume endpoint creation" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "provision", listenPort: 47831 })));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "remove" }));
  });

  it("moves a published tunnel to the listener's new port, and can remove the endpoint", async () => {
    const published: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      tunnelId: "tunnel", phase: "Published", gate: "service-token" };
    const call = vi.fn(async (_request: CloudflareSetupRequest) => published);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47831" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("The tunnel points at a port the gateway no longer uses.");
    fireEvent.click(screen.getByRole("button", { name: "Move tunnel to port 47831" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "provision", hostname: "federation.example.com", listenPort: 47831, gate: "service-token" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove endpoint" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "remove" }));
  });

  it("does not warn about the tunnel port while it matches the listener", async () => {
    const published: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      tunnelId: "tunnel", phase: "Published", gate: "service-token" };
    render(<CloudflareSetup api={{ configureFederationCloudflare: vi.fn(async () => published) } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByRole("button", { name: "Remove endpoint" });
    expect(screen.queryByText("The tunnel points at a port the gateway no longer uses.")).toBeNull();
  });
});
