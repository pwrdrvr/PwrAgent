import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenMiserOutputInspector } from "../TokenMiserOutputInspector";

afterEach(() => { Reflect.deleteProperty(window, "pwragent"); });
const request = { backend: "codex" as const, threadId: "thread-1", objectId: "object-1" };

describe("TokenMiserOutputInspector", () => {
  it("reads only on request, pages the original on the owner, and shows the actual summary", async () => {
    const inspectTokenMiserOutput = vi.fn()
      .mockResolvedValueOnce({ available: true, text: "<script>original</script>", offset: 0, nextOffset: 16_000, totalCharacters: 16_010 })
      .mockResolvedValueOnce({ available: true, text: "last page", offset: 16_000, totalCharacters: 16_010 })
      .mockResolvedValueOnce({ available: true, text: "Actual Luna summary", offset: 0, totalCharacters: 19 });
    Object.assign(window, { pwragent: { inspectTokenMiserOutput } });
    const federationTarget = { scope: "remote" as const, instanceId: "peer-1" };
    render(<TokenMiserOutputInspector {...request} federationTarget={federationTarget} />);
    expect(inspectTokenMiserOutput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View original" }));
    expect(await screen.findByText("<script>original</script>")).toBeInTheDocument();
    expect(inspectTokenMiserOutput).toHaveBeenLastCalledWith({ ...request, federationTarget, source: "original", offset: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("last page")).toBeInTheDocument();
    expect(inspectTokenMiserOutput).toHaveBeenLastCalledWith({ ...request, federationTarget, source: "original", offset: 16_000 });
    fireEvent.click(screen.getByRole("button", { name: "View summary" }));
    expect(await screen.findByText("Actual Luna summary")).toBeInTheDocument();
    expect(inspectTokenMiserOutput).toHaveBeenLastCalledWith({ ...request, federationTarget, source: "summary", offset: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Close output" }));
    expect(screen.queryByText("Actual Luna summary")).not.toBeInTheDocument();
  });

  it("handles eviction between pages and ignores a response after closing", async () => {
    let complete!: (value: unknown) => void;
    const inspectTokenMiserOutput = vi.fn()
      .mockResolvedValueOnce({ available: false })
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    Object.assign(window, { pwragent: { inspectTokenMiserOutput } });
    render(<TokenMiserOutputInspector {...request} />);
    fireEvent.click(screen.getByRole("button", { name: "View original" }));
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View summary" }));
    await waitFor(() => expect(inspectTokenMiserOutput).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Close output" }));
    await act(async () => complete({ available: true, text: "stale private output", offset: 0, totalCharacters: 20 }));
    expect(screen.queryByText("stale private output")).not.toBeInTheDocument();
  });
});
