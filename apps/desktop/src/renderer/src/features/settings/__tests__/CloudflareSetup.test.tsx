import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("preserves the listener address and existing client role when provisioning", async () => {
    const events: string[] = [];
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action !== "status") events.push(request.action);
      return connected;
    });
    const write = vi.fn(async () => { events.push("bind"); return true; });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" listenHost="0.0.0.0" mode="client" onWriteConfig={write} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await waitFor(() => expect(events).toEqual(["bind", "provision"]));
    expect(write).toHaveBeenCalledWith({ federation: { mode: "dual", listenHost: "0.0.0.0", listenPort: 47830 } });
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
    expect(await screen.findByText("Creating CA, Access policy, and tunnel…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create protected endpoint" })).toHaveAttribute("aria-busy", "true");
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
    const statement = screen.getByText(/Creating the endpoint uses this profile’s saved listener/);
    expect(statement).toHaveTextContent("0.0.0.0:47830");
    expect(statement).toHaveTextContent("change it in Configuration and save it first");
    expect(statement).toHaveTextContent("changes from client to dual");
    expect(statement).not.toHaveTextContent("moves from");
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

  it("fills in the free hostname the main process found", async () => {
    const call = vi.fn(async (_request: CloudflareSetupRequest) => ({ ...connected, suggestedHostname: "federation-2.example.com" }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    // A placeholder read as already filled in while Create stayed disabled, and
    // the first conventional name is often another profile's endpoint.
    await waitFor(() => expect(screen.getByLabelText("Cloudflare public hostname")).toHaveValue("federation-2.example.com"));
    expect(screen.getByRole("button", { name: "Create protected endpoint" })).toBeEnabled();
  });

  it("offers the next free name after starting over", async () => {
    const stopped: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      phase: "Setup incomplete — resume creation", resources: ["1 service token"] };
    const call = vi.fn(async (request: CloudflareSetupRequest) => request.action === "remove"
      ? { ...connected, suggestedHostname: "federation-2.example.com", message: "Deleted what this setup had created in Cloudflare: 1 service token. Nothing else changed." }
      : stopped);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start over" }));
    await waitFor(() => expect(screen.getByLabelText("Cloudflare public hostname")).toHaveValue("federation-2.example.com"));
  });

  it("shows the published allowlist after creating a sign-in endpoint, and never offers to empty it", async () => {
    const published: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      tunnelId: "tunnel", phase: "Published", gate: "oauth", emails: ["operator@example.com"] };
    let current: CloudflareSetupStatus = connected;
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "provision") current = published;
      return current;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.click(screen.getByRole("radio", { name: /Sign in with an identity/ }));
    fireEvent.change(screen.getByLabelText("People who can sign in"), { target: { value: "operator@example.com" } });
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await screen.findByRole("button", { name: "Update allowlist" });
    expect(screen.getByLabelText("People who can sign in")).toHaveValue("operator@example.com");
    expect(screen.getByRole("button", { name: "Update allowlist" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("People who can sign in"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Update allowlist" })).toBeDisabled();
  });

  it("offers to reopen a waiting sign-in, and shows an IPC error without Electron's wrapper", async () => {
    let finish: (value: CloudflareSetupStatus) => void = () => undefined;
    const signIn = { endpoint: "wss://federation.example.com", state: "signed-out" as const };
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "sign-in") return new Promise<CloudflareSetupStatus>((resolve) => { finish = resolve; });
      if (request.action === "sign-out") throw new Error("Error invoking remote method 'federation:cloudflare-setup': Error: Cloudflare refused.");
      if (request.action === "reopen-sign-in") return { ...connected, signIn, message: "No sign-in is waiting. Choose Sign in, or open the client setup file again." };
      return { ...connected, signIn };
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect this client" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open the sign-in page again" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "reopen-sign-in" }));
    // The answer shows beside the button while the sign-in still waits; the
    // stage's outcome line is busy reporting the wait itself.
    expect(await screen.findByText("No sign-in is waiting. Choose Sign in, or open the client setup file again.")).toBeInTheDocument();
    expect(screen.getByText(/one-time PIN works with any address/)).toBeInTheDocument();
    finish({ ...connected, signIn: { ...signIn, state: "signed-in" } });
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Cloudflare refused\.$/);
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
    expect(screen.getByText(/set up for 127\.0\.0\.1:47830; resuming moves it to 47831/)).toBeInTheDocument();
    // The button says what it does to the tunnel, not only the sentence above it.
    fireEvent.click(screen.getByRole("button", { name: "Resume and move tunnel to 47831" }));
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

  it("does not offer to move a tunnel onto a listener it cannot reach", async () => {
    const published: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      tunnelId: "tunnel", phase: "Published", gate: "service-token" };
    render(<CloudflareSetup api={{ configureFederationCloudflare: vi.fn(async () => published) } as DesktopApi}
      listenHost="192.168.1.10" listenPort="47831" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("Cloudflare cannot reach a listener on 192.168.1.10.");
    expect(screen.getByRole("button", { name: "Move tunnel to port 47831" })).toBeDisabled();
  });

  it("does not warn about the tunnel port while it matches the listener", async () => {
    const published: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      tunnelId: "tunnel", phase: "Published", gate: "service-token" };
    render(<CloudflareSetup api={{ configureFederationCloudflare: vi.fn(async () => published) } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByRole("button", { name: "Remove endpoint" });
    expect(screen.queryByText("The tunnel points at a port the gateway no longer uses.")).toBeNull();
  });

  const stage = (title: string) => screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;

  it("shows a failure in the stage whose button was clicked, and names it on the section badge", async () => {
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "provision") throw new Error("Error invoking remote method 'federation:cloudflare-setup': Error: An Access application already covers federation.example.com.");
      return connected;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    // Beside the button in step 4, not a screen away at the foot of the section.
    const alert = await within(stage("Protected endpoint")).findByRole("alert");
    expect(alert).toHaveTextContent(/^An Access application already covers federation\.example\.com\.$/);
    expect(within(stage("Cloudflare account")).queryByRole("alert")).toBeNull();
    expect(screen.getByText("Create failed")).toBeInTheDocument();
  });

  it("shows a result in the stage that produced it", async () => {
    const call = vi.fn(async (request: CloudflareSetupRequest) => request.action === "save-draft"
      ? { ...connected, connected: false, message: "Draft saved." }
      : { ...connected, connected: false });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    fireEvent.change(await screen.findByLabelText("Cloudflare account ID"), { target: { value: "a".repeat(32) } });
    // Save draft appears in steps 2 and 4; the one clicked answers.
    fireEvent.click(within(stage("Protected endpoint")).getByRole("button", { name: "Save draft" }));
    expect(await within(stage("Protected endpoint")).findByText("Draft saved.")).toBeInTheDocument();
    expect(within(stage("Cloudflare account")).queryByText("Draft saved.")).toBeNull();
  });

  it("puts the listener back when Create fails before recording anything", async () => {
    const writes: unknown[] = [];
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "provision") throw new Error("The gateway is not listening on 127.0.0.1:47830: Port 47830 is already in use by another process.");
      return connected;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" listenHost="0.0.0.0" mode="client" onWriteConfig={async (patch) => { writes.push(patch); return true; }} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The federation listener was put back as it was."));
    expect(writes).toEqual([
      { federation: { mode: "dual", listenHost: "0.0.0.0", listenPort: 47830 } },
      { federation: { mode: "client", listenHost: "0.0.0.0" } },
    ]);
  });

  it("keeps the listener when a failed Create already recorded resources on it", async () => {
    const writes: unknown[] = [];
    let current: CloudflareSetupStatus = connected;
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "provision") {
        current = { ...connected, hostname: "federation.example.com", listenPort: 47830, resources: ["1 service token"] };
        throw new Error("Cloudflare refused the tunnel.");
      }
      return current;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" listenHost="0.0.0.0" mode="client" onWriteConfig={async (patch) => { writes.push(patch); return true; }} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Cloudflare refused the tunnel\.$/);
    expect(writes).toHaveLength(1);
  });

  it("leads a connected client with its connection, and folds away the import steps", async () => {
    const call = vi.fn(async (_request: CloudflareSetupRequest) => ({ ...connected, zoneName: undefined, connected: false,
      clientConnection: { endpoint: "wss://federation.example.com", state: "connected" as const, gateway: "Mac mini / dev" } }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    expect(await screen.findByRole("status", { name: "Cloudflare client connection" }))
      .toHaveTextContent("Federation is connected to Mac mini / dev through this endpoint.");
    expect(screen.getByText("Connect with a different setup file").closest("details")).not.toHaveAttribute("open");
  });

  it("says why a client is not connected", async () => {
    const detail = "Cloudflare Access refused this client's credential for federation.example.com. It may have been revoked or expired; ask the gateway's operator for a new client setup file.";
    const call = vi.fn(async (_request: CloudflareSetupRequest) => ({ ...connected, zoneName: undefined, connected: false,
      clientConnection: { endpoint: "wss://federation.example.com", state: "rejected" as const, detail } }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    const connection = await screen.findByRole("status", { name: "Cloudflare client connection" });
    expect(connection).toHaveTextContent(`Federation is not connected. ${detail}`);
    expect(screen.getAllByText("Refused").length).toBeGreaterThan(0);
  });

  it("offers sign-in help during an import only once a browser sign-in is waiting", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let pending = false;
      const call = vi.fn(async (request: CloudflareSetupRequest) => {
        if (request.action === "import-client") return new Promise<CloudflareSetupStatus>(() => undefined);
        return { ...connected, signInPending: pending || undefined };
      });
      render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
        listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect this client" }));
      fireEvent.change(screen.getByLabelText("Cloudflare client import password"), { target: { value: "transfer-password" } });
      fireEvent.click(screen.getByRole("button", { name: "Open client setup file" }));
      await act(async () => { vi.advanceTimersByTime(1000); });
      // A service-token file never opens a browser; nothing to cancel.
      expect(screen.queryByRole("button", { name: "Open the sign-in page again" })).toBeNull();
      pending = true;
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(await screen.findByRole("button", { name: "Open the sign-in page again" })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("names a newer cloudflared release and how to update to it", async () => {
    const call = vi.fn(async (_request: CloudflareSetupRequest) => ({ ...connected, connectorRunning: true,
      connectorVersion: "2026.8.3", connectorUpdate: "2026.9.0" }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("cloudflared 2026.9.0 is available.");
    expect(screen.getByText("cloudflared 2026.8.3 is running.")).toBeInTheDocument();
    expect(screen.getByText(/keeps the old version until you stop and start it in step 5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "How to update cloudflared" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "open-link", link: "cloudflared-update-docs" }));
  });

  it("says nothing about updates while the installed cloudflared is current", async () => {
    render(<CloudflareSetup api={{ configureFederationCloudflare: vi.fn(async () => ({ ...connected, connectorVersion: "2026.9.0" })) } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("cloudflared 2026.9.0 is installed. PwrAgent starts it with the gateway.");
    expect(screen.queryByRole("button", { name: "How to update cloudflared" })).toBeNull();
  });

  it("inspects the endpoint's own Access application", async () => {
    const published: CloudflareSetupStatus = { ...connected, hostname: "federation.example.com", listenPort: 47830,
      tunnelId: "tunnel", phase: "Published", gate: "service-token" };
    const call = vi.fn(async (_request: CloudflareSetupRequest) => published);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Access application" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "open-link", link: "dash-endpoint-application" }));
  });
});


describe("Cloudflare operation feedback", () => {
  it("releases a failed import without waiting for another status read", async () => {
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "import-client") throw new Error("Sign-in endpoint unreachable");
      if (call.mock.calls.length > 1) return new Promise<CloudflareSetupStatus>(() => {});
      return connected;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.click(screen.getByRole("button", { name: "Connect this client" }));
    fireEvent.change(screen.getByLabelText("Cloudflare client import password"), { target: { value: "transfer-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Open client setup file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in endpoint unreachable");
    expect(screen.getByRole("button", { name: "Open client setup file" })).toBeEnabled();
  });

  it("shows pending and saved allowlist feedback beside the action", async () => {
    const published = { ...connected, hostname: "federation.example.com", phase: "Published", gate: "oauth" as const, emails: ["one@example.com"] };
    let complete!: (status: CloudflareSetupStatus) => void;
    const call = vi.fn(async (request: CloudflareSetupRequest) => request.action === "set-emails"
      ? new Promise<CloudflareSetupStatus>((resolve) => { complete = resolve; }) : published);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" listenHost="0.0.0.0" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    fireEvent.change(await screen.findByLabelText("People who can sign in"), { target: { value: "one@example.com\ntwo@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Update allowlist" }));
    const update = screen.getByRole("button", { name: "Update allowlist" });
    expect(update).toBeDisabled();
    expect(update).toHaveAttribute("aria-busy", "true");
    // Beside the action: the pending line shares the button's row.
    expect(update.parentElement).toHaveTextContent("Updating the Access policy…");
    await act(async () => complete({ ...published, emails: ["one@example.com", "two@example.com"], message: "Sign-in allowlist updated." }));
    expect(screen.getByText("Sign-in allowlist updated.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update allowlist" })).toBeDisabled();
  });

  it("marks only the client row whose revoke is running", async () => {
    const published: CloudflareSetupStatus = {
      ...connected, gate: "service-token", hostname: "federation.example.com", phase: "Published",
      clients: [
        { id: "laptop", label: "Travel laptop", expiresAt: "2027-01-01T00:00:00Z", revoked: false },
        { id: "studio", label: "Studio Mac", expiresAt: "2027-01-01T00:00:00Z", revoked: false },
      ],
    };
    const call = vi.fn(async (request: CloudflareSetupRequest) => request.action === "revoke-client"
      ? new Promise<CloudflareSetupStatus>(() => {}) : published);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    const revokes = await screen.findAllByRole("button", { name: "Revoke service token" });
    fireEvent.click(revokes[0]);
    await waitFor(() => expect(revokes[0]).toHaveAttribute("aria-busy", "true"));
    expect(revokes[1]).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByText("Revoking service token…")).toHaveLength(1);
    expect(screen.getByText("Travel laptop").closest(".cloudflare-setup__client")).toHaveTextContent("Revoking service token…");
  });

  it("marks only the Save draft that was clicked", async () => {
    const call = vi.fn(async (request: CloudflareSetupRequest) => request.action === "save-draft"
      ? new Promise<CloudflareSetupStatus>(() => {}) : { ...connected, connected: false });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    fireEvent.change(await screen.findByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    const drafts = screen.getAllByRole("button", { name: "Save draft" });
    expect(drafts).toHaveLength(2);
    fireEvent.click(drafts[0]);
    await waitFor(() => expect(drafts[0]).toHaveAttribute("aria-busy", "true"));
    expect(drafts[1]).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByText("Saving draft…")).toHaveLength(1);
  });
});


describe("Cloudflare listener address", () => {
  it("says nothing about a loopback listener", async () => {
    render(<CloudflareSetup api={{ configureFederationCloudflare: vi.fn(async () => connected) } as DesktopApi}
      listenPort="47830" listenHost="127.0.0.1" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    expect(screen.queryByRole("button", { name: /^Listen on/ })).not.toBeInTheDocument();
  });

  it("offers loopback in step 4 when peers on the network can connect directly", async () => {
    const write = vi.fn(async () => true);
    const changed = vi.fn(async () => {});
    render(<CloudflareSetup api={{ configureFederationCloudflare: vi.fn(async () => connected) } as DesktopApi}
      listenPort="47830" listenHost="0.0.0.0" mode="gateway" onWriteConfig={write} onSettingsChanged={changed} />);
    fireEvent.change(await screen.findByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    const notice = screen.getByText("Peers on your network can also connect directly.").closest(".cloudflare-setup__notice") as HTMLElement;
    // Beside the sentence that names the listener, not above the whole setup.
    expect(notice.closest(".automation-stage")).toHaveTextContent("Protected endpoint");
    expect(within(notice).queryByRole("button", { name: "Listen on 0.0.0.0" })).not.toBeInTheDocument();
    // 0.0.0.0 accepts loopback, so Create stays available.
    expect(screen.getByRole("button", { name: "Create protected endpoint" })).toBeEnabled();
    fireEvent.click(within(notice).getByRole("button", { name: "Listen on 127.0.0.1 only" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ federation: { listenHost: "127.0.0.1" } }));
    expect(await screen.findByText("Listener address saved as 127.0.0.1.")).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
  });

  it("blocks Create on an address the tunnel cannot reach", async () => {
    const call = vi.fn(async () => connected);
    const write = vi.fn(async () => true);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" listenHost="192.168.1.10" mode="gateway" onWriteConfig={write} onSettingsChanged={async () => {}} />);
    fireEvent.change(await screen.findByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    expect(screen.getByText("Cloudflare cannot reach a listener on 192.168.1.10.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create protected endpoint" })).toBeDisabled();
    expect(screen.getByText("Still needed: a listener on 127.0.0.1 or 0.0.0.0.")).toBeInTheDocument();
    expect(screen.queryByText(/Everything needed to create the endpoint is in place/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Listen on 0.0.0.0" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ federation: { listenHost: "0.0.0.0" } }));
    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({ action: "provision" }));
  });

  it("reports a failed listener save in step 4", async () => {
    render(<CloudflareSetup api={{ configureFederationCloudflare: vi.fn(async () => connected) } as DesktopApi}
      listenPort="47830" listenHost="0.0.0.0" onWriteConfig={async () => false} onSettingsChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Listen on 127.0.0.1 only" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The listener address could not be saved.");
    expect(alert.closest(".automation-stage")).toHaveTextContent("Protected endpoint");
  });
});


describe("Cloudflare partial-operation recovery", () => {
  const published: CloudflareSetupStatus = {
    ...connected, gate: "service-token", hostname: "federation.example.com", phase: "Published",
  };
  const issued: CloudflareSetupStatus = {
    ...published, clients: [{ id: "issued-token", label: "Travel laptop", expiresAt: "2027-01-01T00:00:00Z", revoked: false }],
  };

  it.each(["export-client", "remove"] as const)("refreshes persisted state after %s fails without holding controls", async (action) => {
    let refresh!: (status: CloudflareSetupStatus) => void;
    let failed = false;
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === action) {
        failed = true;
        throw new Error("Operation partially completed");
      }
      if (failed) return new Promise<CloudflareSetupStatus>((resolve) => { refresh = resolve; });
      return published;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare client name");
    fireEvent.change(screen.getByLabelText("Cloudflare client name"), { target: { value: "Travel laptop" } });
    fireEvent.change(screen.getByLabelText("Cloudflare client transfer password"), { target: { value: "long-enough-password" } });
    const button = action === "remove" ? "Remove endpoint" : "Issue & save client setup";
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Operation partially completed");
    expect(screen.getByRole("button", { name: button })).toBeEnabled();
    await act(async () => refresh(action === "remove" ? connected : issued));
    expect(screen.getByRole("alert")).toHaveTextContent("Operation partially completed");
    if (action === "remove") {
      expect(screen.queryByRole("button", { name: "Remove endpoint" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create protected endpoint" })).toBeInTheDocument();
    } else {
      expect(screen.getByText("Travel laptop")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Revoke service token" })).toBeEnabled();
    }
  });

  it("discards a delayed recovery read after a newer action succeeds", async () => {
    let refresh!: (status: CloudflareSetupStatus) => void;
    let failed = false;
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action === "remove") {
        if (failed) return connected;
        failed = true;
        throw new Error("Removal partially completed");
      }
      if (failed) return new Promise<CloudflareSetupStatus>((resolve) => { refresh = resolve; });
      return published;
    });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove endpoint" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Remove endpoint" }));
    await screen.findByRole("button", { name: "Create protected endpoint" });
    await act(async () => refresh(published));
    expect(screen.queryByRole("button", { name: "Remove endpoint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
