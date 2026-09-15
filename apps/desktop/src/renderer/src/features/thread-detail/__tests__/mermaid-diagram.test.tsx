import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "../MermaidDiagram";
import { ThreadMarkdown } from "../ThreadMarkdown";

const renderMermaid = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/mermaid-runtime", () => ({ renderMermaid }));
vi.mock("../../../lib/diagram-image", () => ({
  createDiagramImage: vi.fn(async (src: string) => ({ src, width: 4200, height: 64 })),
}));
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
    expect(screen.getByRole("button", { name: "Expand Mermaid diagram" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByLabelText("Diagram source")).toHaveTextContent("A --> B");
    fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
    expect(api.copyText).toHaveBeenCalledWith("flowchart LR\nA --> B\n");
  });

  it("falls back to source on failure and renders a completed streamed diagram", async () => {
    renderMermaid.mockRejectedValueOnce(new Error("incomplete"));
    const view = render(<MermaidDiagram source="flowchart LR\nA -->" />);
    await enterViewport();
    expect(screen.getByText("Diagram unavailable")).toBeInTheDocument();
    view.rerender(<MermaidDiagram source="flowchart LR\nA --> B" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByRole("button", { name: "Expand Mermaid diagram" })).toBeInTheDocument();
  });

  it("discards stale work when the source changes", async () => {
    let finish: (image: string) => void = () => undefined;
    renderMermaid.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const view = render(<MermaidDiagram source="flowchart LR\nA --> B" />);
    await enterViewport();
    view.rerender(<MermaidDiagram source="flowchart LR\nC --> D" />);
    await act(async () => { finish("data:image/svg+xml,stale"); });
    expect(screen.queryByRole("button", { name: "Expand Mermaid diagram" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByRole("button", { name: "Expand Mermaid diagram" })).toHaveAttribute("src", "data:image/svg+xml,test");
  });
  it("keeps the image and source toggle mounted as trailing prose streams", async () => {
    const markdown = "```mermaid\nflowchart LR\nA --> B\n```\n\n";
    const view = render(<ThreadMarkdown text={markdown + "First"} />);
    await enterViewport();
    const image = screen.getByRole("button", { name: "Expand Mermaid diagram" });
    expect(image).toHaveAttribute("width", "4200");
    view.rerender(<ThreadMarkdown text={markdown + "First paragraph"} />);
    expect(screen.getByRole("button", { name: "Expand Mermaid diagram" })).toBe(image);
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    const source = screen.getByLabelText("Diagram source");
    view.rerender(<ThreadMarkdown text={markdown + "First paragraph continues"} />);
    expect(screen.getByLabelText("Diagram source")).toBe(source);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(renderMermaid).toHaveBeenCalledTimes(1);
  });

  it("opens the shared lightbox by keyboard with zoom controls and closes with Escape", async () => {
    render(<ThreadMarkdown text={"```mermaid\nflowchart LR\nA --> B\n```"} />);
    await enterViewport();
    fireEvent.keyDown(screen.getByRole("button", { name: "Expand Mermaid diagram" }), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Expanded Mermaid diagram" })).toBeInTheDocument();
    fireEvent.wheel(screen.getByLabelText("Image pan and zoom"), { ctrlKey: true, deltaY: 10000 });
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Fit to window" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

});

describe("Mermaid clipboard actions", () => {
  it("copies the original image from toolbar and lightbox, and reports failures without success", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const png = new Blob(["original high-resolution PNG"], { type: "image/png" });
    const fetchImage = vi.fn().mockResolvedValue({ ok: true, blob: async () => png });
    vi.stubGlobal("fetch", fetchImage);
    vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    render(<MermaidDiagram source="flowchart LR\nA --> B" />);
    await enterViewport();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy image" })));
    expect(fetchImage).toHaveBeenCalledWith("data:image/svg+xml,test");
    expect(write.mock.calls[0][0][0].data["image/png"]).toBe(png);
    expect(screen.getByText("Copy image succeeded")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Expand Mermaid diagram" }));
    write.mockRejectedValueOnce(new Error("denied"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy image" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Copy image failed");
    expect(screen.getByRole("button", { name: "Copy image" })).toBeInTheDocument();
    expect(write.mock.calls[1][0][0].data["image/png"]).toBe(png);
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it("does not claim success before the clipboard promise resolves", async () => {
    let finish = () => {};
    const api = { copyText: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) };
    render(<MermaidDiagram source="flowchart LR\nA --> B" desktopApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
