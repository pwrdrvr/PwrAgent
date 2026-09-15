import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "../MermaidDiagram";
import { ThreadMarkdown } from "../ThreadMarkdown";

const renderMermaid = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/mermaid-runtime", () => ({ renderMermaid }));
let intersect: (entries: { isIntersecting: boolean }[]) => void;

beforeEach(() => {
  vi.useFakeTimers();
  renderMermaid.mockReset().mockResolvedValue("data:image/svg+xml,test");
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function enterViewport() {
  await act(async () => { intersect([{ isIntersecting: true }]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
}

describe("Mermaid transcript rendering", () => {
  it("keeps ordinary code unchanged and never starts Mermaid", async () => {
    render(<ThreadMarkdown text={'```text\nflowchart LR\nA --> B\n```'} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByLabelText("Code block")).toHaveTextContent("flowchart LR");
    expect(renderMermaid).not.toHaveBeenCalled();
  });

  it("waits for visibility, renders, and retains copyable source", async () => {
    const api = { copyText: vi.fn().mockResolvedValue(undefined) };
    render(<ThreadMarkdown desktopApi={api} text={'```mermaid\nflowchart LR\nA --> B\n```'} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(renderMermaid).not.toHaveBeenCalled();
    await enterViewport();
    expect(screen.getByRole("img")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByLabelText("Diagram source")).toHaveTextContent("A --> B");
    fireEvent.click(screen.getByRole("button", { name: "Copy diagram source" }));
    expect(api.copyText).toHaveBeenCalledWith("flowchart LR\nA --> B\n");
  });

  it("falls back to source on failure and renders a completed streamed diagram", async () => {
    renderMermaid.mockRejectedValueOnce(new Error("incomplete"));
    const view = render(<MermaidDiagram source="flowchart LR\nA -->" />);
    await enterViewport();
    expect(screen.getByText("Diagram unavailable")).toBeInTheDocument();
    view.rerender(<MermaidDiagram source="flowchart LR\nA --> B" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("discards stale work when the source changes", async () => {
    let finish: (image: string) => void = () => undefined;
    renderMermaid.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const view = render(<MermaidDiagram source="flowchart LR\nA --> B" />);
    await enterViewport();
    view.rerender(<MermaidDiagram source="flowchart LR\nC --> D" />);
    await act(async () => { finish("data:image/svg+xml,stale"); });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/svg+xml,test");
  });
});
