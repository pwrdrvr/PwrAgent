import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ServiceUiRequest, ServiceUiResponse, ThreadService } from "@pwragent/shared";
import { ThreadServices } from "../ThreadServices";

afterEach(cleanup);
const service: ThreadService = {
  backend: "codex", threadId: "fixture-thread", serviceId: "fixture-service", ownerInstanceId: "fixture-owner",
  ownerSessionId: "fixture-session", address: "127.0.0.1", port: 3000, protocol: "http", name: "Preview app",
  description: "Invented development data", createdAt: 1000, expiresAt: 9_000_000,
};

it("keeps advertisement separate from explicit Connect and Open, and releases the selected thread on unmount", async () => {
  let state: ServiceUiResponse = { services: [service], forwards: [] };
  const api = vi.fn(async (request: ServiceUiRequest): Promise<ServiceUiResponse> => {
    if (request.action === "connect") state = { ...state, forwards: [{ forwardId: "forward", service, localPort: 43210,
      url: "http://127.0.0.1:43210/", sentBytes: 0, receivedBytes: 0 }] };
    if (request.action === "disconnect") state = { ...state, forwards: [] };
    return state;
  });
  const view = render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" ownerLabel="Fixture Mac" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Services · 1" })).toBeInTheDocument());
  expect(api.mock.calls.map(([request]) => request.action)).toEqual(["watch"]);
  fireEvent.click(screen.getByRole("button", { name: "Services · 1" }));
  expect(screen.getByText(/Fixture Mac · HTTP/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("button", { name: "Disconnect" });
  expect(api.mock.calls.filter(([request]) => request.action === "open")).toHaveLength(0);
  expect(screen.getByText(/127.0.0.1:43210 → 127.0.0.1:3000/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ action: "open", forwardId: "forward", instanceId: "fixture-owner", threadId: "fixture-thread" })));
  view.unmount();
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ action: "leave", instanceId: "fixture-owner", threadId: "fixture-thread" }));
});

it("shows owner upgrade errors without offering a connection", async () => {
  const api = vi.fn(async (): Promise<ServiceUiResponse> => { throw new Error("Owner requires service_forward_v1 support."); });
  render(<ThreadServices api={api} backend="codex" threadId="fixture-thread" instanceId="fixture-owner" />);
  fireEvent.click(screen.getByRole("button", { name: "Services · 0" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Owner requires");
  expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
});
