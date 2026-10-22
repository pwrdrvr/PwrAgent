import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ServiceUiRequest, ServiceUiResponse, ThreadService } from "@pwragent/shared";
import { ThreadServices } from "../ThreadServices";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const service: ThreadService = {
  backend: "codex", threadId: "fixture-thread", serviceId: "fixture-service", ownerInstanceId: "fixture-owner",
  ownerSessionId: "fixture-session", address: "127.0.0.1", port: 3000, protocol: "http", name: "Preview app",
  description: "Invented development data", createdAt: 1000, expiresAt: 9_000_000,
};

it("keeps advertisement separate from explicit Forward Port and Open in Browser, and releases the selected thread on unmount", async () => {
  let state: ServiceUiResponse = { services: [service], forwards: [] };
  const api = vi.fn(async (request: ServiceUiRequest): Promise<ServiceUiResponse> => {
    if (request.action === "connect") state = { ...state, forwards: [{ forwardId: "forward", service, localPort: 43210,
      url: "http://127.0.0.1:43210/", sentBytes: 0, receivedBytes: 0 }] };
    if (request.action === "disconnect") state = { ...state, forwards: [] };
    return state;
  });
  const view = render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" ownerLabel="Fixture Mac" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Ports (1)" })).toBeInTheDocument());
  expect(api.mock.calls.map(([request]) => request.action)).toEqual(["watch"]);
  fireEvent.click(screen.getByRole("button", { name: "Ports (1)" }));
  expect(screen.getByText("127.0.0.1:3000 on Fixture Mac")).toBeInTheDocument();
  expect(screen.getByText("Not forwarded")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open in Browser" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Forward Port" }));
  await screen.findByRole("button", { name: "Stop Forwarding" });
  expect(api.mock.calls.filter(([request]) => request.action === "open")).toHaveLength(0);
  expect(screen.getByText("127.0.0.1:3000 on Fixture Mac").closest(".thread-services__mapping")).toHaveTextContent("127.0.0.1:43210→127.0.0.1:3000 on Fixture Mac");
  // The collapsed bar names the live local address, so the forward is visible without expanding.
  expect(screen.getByRole("button", { name: "Ports (1)" })).toHaveAccessibleDescription("Forwarding127.0.0.1:43210");
  expect(screen.getByRole("button", { name: "Open 127.0.0.1:43210 in Browser" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open in Browser" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ action: "open", forwardId: "forward", instanceId: "fixture-owner", threadId: "fixture-thread" })));
  view.unmount();
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ action: "leave", instanceId: "fixture-owner", threadId: "fixture-thread" }));
});

it("stays hidden on a thread with no ports, including an owner without service support", async () => {
  const api = vi.fn(async (): Promise<ServiceUiResponse> => { throw new Error("Owner requires service_forward_v1 support."); });
  render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(screen.queryByRole("region", { name: "Thread ports" })).not.toBeInTheDocument();
});

it("shows a lookup error without offering a connection once the thread had ports", async () => {
  vi.useFakeTimers();
  let fail = false;
  const api = vi.fn(async (): Promise<ServiceUiResponse> => {
    if (fail) throw new Error("Owner requires service_forward_v1 support.");
    return { services: [service], forwards: [] };
  });
  await act(async () => { render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" />); });
  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  fireEvent.click(screen.getByRole("button", { name: "Ports (0)" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Owner requires");
  expect(screen.queryByRole("button", { name: "Forward Port" })).not.toBeInTheDocument();
});

it("explains before a click that the owner has forwarding switched off", async () => {
  const api = vi.fn(async (_request: ServiceUiRequest): Promise<ServiceUiResponse> => ({ services: [service], forwards: [], forwarding: "blocked" }));
  render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" ownerLabel="Fixture Mac" />);
  const toggle = await screen.findByRole("button", { name: "Ports (1)" });
  expect(toggle).toHaveAccessibleDescription("Forwarding is off on Fixture Mac");
  fireEvent.click(toggle);
  const forward = screen.getByRole("button", { name: "Forward Port" });
  expect(forward).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(forward);
  expect(api.mock.calls.map(([request]) => request.action)).not.toContain("connect");
  expect(screen.getByText("Turn on Allow port forwarding in Fixture Mac’s Federation settings.", { selector: "p" })).toBeInTheDocument();
});

it("shows the owner which peers are forwarding its port and links to Settings when it is off", async () => {
  let state: ServiceUiResponse = { services: [service], forwards: [], forwarding: "allowed", inbound: [{ serviceId: service.serviceId, peerLabels: ["Fixture Laptop"] }] };
  const api = vi.fn(async (): Promise<ServiceUiResponse> => state);
  const openSettings = vi.fn();
  const view = render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" onOpenFederationSettings={openSettings} />);
  const toggle = await screen.findByRole("button", { name: "Ports (1)" });
  expect(toggle).toHaveAccessibleDescription("Forwarded to Fixture Laptop");
  fireEvent.click(toggle);
  expect(screen.getByText("In use by Fixture Laptop")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Forward Port" })).not.toBeInTheDocument();
  view.unmount();
  state = { services: [service], forwards: [], forwarding: "blocked", inbound: [] };
  render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" onOpenFederationSettings={openSettings} />);
  const blocked = await screen.findByRole("button", { name: "Ports (1)" });
  expect(blocked).toHaveAccessibleDescription("Forwarding is off on this machine");
  fireEvent.click(blocked);
  fireEvent.click(screen.getByRole("button", { name: "Federation Settings" }));
  expect(openSettings).toHaveBeenCalledTimes(1);
});

it("restores an invalidated watch after a runtime restart without reconnecting forwards", async () => {
  vi.useFakeTimers();
  let registered = false;
  let state: ServiceUiResponse = { services: [service], forwards: [] };
  const api = vi.fn(async (request: ServiceUiRequest): Promise<ServiceUiResponse> => {
    if (request.action === "watch") registered = true;
    if (!registered) throw new Error("Service viewer closed or changed thread.");
    if (request.action === "connect") state = { ...state, forwards: [{ forwardId: "forward", service, localPort: 43210,
      url: "http://127.0.0.1:43210/", sentBytes: 0, receivedBytes: 0 }] };
    return state;
  });
  await act(async () => { render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" />); });
  fireEvent.click(screen.getByRole("button", { name: "Ports (1)" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Forward Port" })); });
  expect(screen.getByRole("button", { name: "Stop Forwarding" })).toBeInTheDocument();
  // A runtime restart drops watches and forwards while the renderer stays mounted.
  registered = false;
  state = { services: [service], forwards: [] };
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole("button", { name: "Forward Port" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(api.mock.calls.map(([request]) => request.action)).toEqual(["watch", "connect", "watch"]);
  expect(api.mock.calls[2]![0].viewId).toBe(api.mock.calls[0]![0].viewId);
});
