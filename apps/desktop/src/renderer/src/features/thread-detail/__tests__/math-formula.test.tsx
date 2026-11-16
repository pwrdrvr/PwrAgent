import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MathFormula } from "../MathFormula";
import { MathClipboardApiContext } from "../../../lib/math-clipboard-context";
import { copyImage } from "../../../lib/copy-image";
import { formulaToHtml, formulaToPng } from "../../../lib/math-clipboard-export";

vi.mock("../../../lib/copy-image", () => ({ copyImage: vi.fn(async () => undefined) }));
vi.mock("../../../lib/math-clipboard-export", () => ({
  formulaToHtml: vi.fn(async () => "<span>formatted</span>"),
  formulaToPng: vi.fn(async () => "data:image/png;base64,formula"),
}));
afterEach(() => { vi.clearAllMocks(); });

function fixture() {
  const copyText = vi.fn(async () => undefined);
  const copyRichText = vi.fn(async () => undefined);
  const latex = String.raw`\frac{x^2}{2}`;
  const content = (source: string) => <MathClipboardApiContext.Provider value={{ copyText, copyRichText }}>
    <MathFormula node={{ properties: { dataLatex: source, dataDisplay: true } }}>
      <span className="katex"><span className="katex-html">x²/2</span></span>
    </MathFormula>
  </MathClipboardApiContext.Provider>;
  const view = render(content(latex));
  return { ...view, copyText, copyRichText, latex, update: (source: string) => view.rerender(content(source)) };
}

describe("formula copy menu", () => {
  it("copies exact LaTeX without invoking image or HTML export", async () => {
    const view = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Copy formula" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy LaTeX" }));
    await waitFor(() => expect(view.copyText).toHaveBeenCalledWith(view.latex));
    expect(formulaToPng).not.toHaveBeenCalled();
    expect(formulaToHtml).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Formula copied");
    expect(view.container).not.toHaveTextContent("Formula copied");
  });

  it("copies formatted HTML with exact LaTeX as the plain-text flavor", async () => {
    const view = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Copy formula" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy formatted HTML" }));
    await waitFor(() => expect(view.copyRichText).toHaveBeenCalledWith({
      text: view.latex, html: "<span>formatted</span>",
    }));
    expect(formulaToHtml).toHaveBeenCalledWith(view.container.querySelector(".katex"));
  });

  it("waits for PNG generation and clipboard acceptance before reporting success", async () => {
    let finish!: (value: string) => void;
    vi.mocked(formulaToPng).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    fixture();
    const trigger = screen.getByRole("button", { name: "Copy formula" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy transparent PNG" }));
    await waitFor(() => expect(formulaToPng).toHaveBeenCalledOnce());
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { finish("data:image/png;base64,generated"); });
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith("data:image/png;base64,generated"));
    expect(screen.getByRole("status")).toHaveTextContent("Formula copied");
  });

  it("reports a rejected image clipboard write without claiming success", async () => {
    vi.mocked(copyImage).mockRejectedValueOnce(new Error("Permission denied"));
    fixture();
    fireEvent.click(screen.getByRole("button", { name: "Copy formula" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy transparent PNG" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy formula");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("supports keyboard navigation, Escape, and focus restoration", () => {
    fixture();
    const trigger = screen.getByRole("button", { name: "Copy formula" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Copy transparent PNG" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Copy LaTeX" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("resets source-dependent menus and feedback when a formula changes", async () => {
    const view = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Copy formula" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy LaTeX" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Formula copied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy formula" }));
    view.update("y=2");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy formula" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy LaTeX" }));
    await waitFor(() => expect(view.copyText).toHaveBeenLastCalledWith("y=2"));
  });
});
