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
  await waitFor(() => expect(screen.getByRole("button", { name: "Ports · 1" })).toBeInTheDocument());
  expect(api.mock.calls.map(([request]) => request.action)).toEqual(["watch"]);
  fireEvent.click(screen.getByRole("button", { name: "Ports · 1" }));
  expect(screen.getByText(/Fixture Mac · HTTP/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open in Browser" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Forward Port" }));
  await screen.findByRole("button", { name: "Stop Forwarding" });
  expect(api.mock.calls.filter(([request]) => request.action === "open")).toHaveLength(0);
  expect(screen.getByText(/127.0.0.1:43210 → 127.0.0.1:3000/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open in Browser" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ action: "open", forwardId: "forward", instanceId: "fixture-owner", threadId: "fixture-thread" })));
  view.unmount();
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ action: "leave", instanceId: "fixture-owner", threadId: "fixture-thread" }));
});

it("shows owner upgrade errors without offering a connection", async () => {
  const api = vi.fn(async (): Promise<ServiceUiResponse> => { throw new Error("Owner requires service_forward_v1 support."); });
  render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" />);
  fireEvent.click(screen.getByRole("button", { name: "Ports · 0" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Owner requires");
  expect(screen.queryByRole("button", { name: "Forward Port" })).not.toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("button", { name: "Ports · 1" }));
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
