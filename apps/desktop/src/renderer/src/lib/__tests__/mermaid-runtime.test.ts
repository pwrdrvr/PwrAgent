import { describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width:4200px" viewBox="0 0 4200 64" />' })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));
import { renderMermaid } from "../mermaid-runtime";

const palette = { background: "white", foreground: "black", line: "gray", surface: "white", accent: "orange" };

describe("Mermaid runtime ownership", () => {
  it("serializes rendering, reuses cached results, and leaves no temporary DOM", async () => {
    const before = document.body.childElementCount;
    const source = "flowchart LR\nA --> B";
    const [first, second] = await Promise.all([
      renderMermaid(source, palette, () => true),
      renderMermaid(source, palette, () => true),
    ]);
    expect(first).toMatch(/^data:image\/svg\+xml/);
    const svg = new DOMParser().parseFromString(decodeURIComponent(first!.split(",")[1]), "image/svg+xml").documentElement;
    expect(svg.getAttribute("width")).toBe("4200");
    expect(svg.getAttribute("height")).toBe("64");
    expect(svg.style.maxWidth).toBe("");
    expect(second).toBe(first);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: "strict", startOnLoad: false, htmlLabels: false, maxEdges: 200,
    }));
    expect(document.body.childElementCount).toBe(before);
  });

  it("skips cancelled jobs before calling Mermaid", async () => {
    const calls = mermaid.render.mock.calls.length;
    expect(await renderMermaid("flowchart LR\nCancelled", palette, () => false)).toBeUndefined();
    expect(mermaid.render).toHaveBeenCalledTimes(calls);
  });

  it.each([
    "%%{init: {securityLevel: 'loose'}}%%\nflowchart LR\nA-->B",
    "---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B",
    "flowchart LR\nA@{ img: '//example.com/image.png' }",
    "flowchart LR\nclassDef x fill:url(//example.com/image.svg)",
    "x".repeat(20_001),
  ])("rejects configuration, resources and oversized input before rendering: %.40s", async (source) => {
    const calls = mermaid.render.mock.calls.length;
    await expect(renderMermaid(source, palette, () => true)).rejects.toThrow();
    expect(mermaid.render).toHaveBeenCalledTimes(calls);
  });

  it("cleans up after an error and permits the next render", async () => {
    const before = document.body.childElementCount;
    mermaid.render.mockRejectedValueOnce(new Error("parse failed"));
    await expect(renderMermaid("invalid diagram", palette, () => true)).rejects.toThrow();
    expect(document.body.childElementCount).toBe(before);
    expect(await renderMermaid("flowchart LR\nRecovered", palette, () => true)).toBeTruthy();
  });
});
