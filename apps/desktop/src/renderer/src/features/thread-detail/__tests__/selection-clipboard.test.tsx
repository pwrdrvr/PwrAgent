import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadMarkdown } from "../ThreadMarkdown";

const FEATURE_REQUEST = [
  "**Sandboxer feature request**",
  "",
  "We want agents to drive Sandboxer only through MCP: no `sbx` install, no CLI calls.",
  "",
  "1. **Hosted MCP endpoint.** Streamable HTTP at `https://mcp.sandboxer.com/`:",
  "   - OAuth sign-in on first use.",
  "   - Keep `sbx mcp` for people who want it local.",
  "2. **Full lifecycle tools in the MCP, so nothing needs the CLI:**",
  "   - `delete_sandbox` (most important for us);",
  "   - `extend_sandbox` (change the TTL);",
  "3. **Labels on sandboxes and snapshots.** Set them on `create_sandbox`.",
  "4. **Create from the newest snapshot that matches labels.**",
  "",
  "---",
  "",
  "Items 1 and 2 matter most.",
].join("\n");

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

function textNode(container: HTMLElement, text: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) {
      return node as Text;
    }
  }
  throw new Error(`No text node contains ${JSON.stringify(text)}`);
}

// Selects from the start of `from` to the end of `to`, or to `endOffset`
// within the node that holds `to`.
function select(
  container: HTMLElement,
  from: string,
  to: string,
  options: { endOffset?: number } = {},
): void {
  const startNode = textNode(container, from);
  const endNode = textNode(container, to);
  const range = document.createRange();
  range.setStart(startNode, startNode.data.indexOf(from));
  range.setEnd(
    endNode,
    options.endOffset ?? endNode.data.indexOf(to) + to.length,
  );
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function copy(container: HTMLElement) {
  const setData = vi.fn();
  const notPrevented = fireEvent.copy(container.querySelector(".thread-markdown")!, {
    clipboardData: { setData },
  });
  const flavor = (type: string) =>
    setData.mock.calls.find(([format]) => format === type)?.[1] as string | undefined;
  return { html: flavor("text/html"), notPrevented, text: flavor("text/plain") };
}

describe("copying a transcript selection", () => {
  it("copies a whole rendered message back to its Markdown", () => {
    const { container } = render(<ThreadMarkdown text={FEATURE_REQUEST} />);
    select(container, "Sandboxer feature request", "Items 1 and 2 matter most.");

    const { html, notPrevented, text } = copy(container);

    expect(notPrevented).toBe(false);
    expect(text).toBe(FEATURE_REQUEST);
    expect(html).toContain("<ol>\n<li><strong>Hosted MCP endpoint.</strong>");
    expect(html).toContain("<ul>\n<li>OAuth sign-in on first use.</li>");
    // Copy buttons and other controls do not reach the clipboard.
    expect(html).not.toContain("button");
    expect(html).not.toContain("class=");
  });

  it("keeps each item's number when the selection starts mid-list", () => {
    const { container } = render(<ThreadMarkdown text={FEATURE_REQUEST} />);
    select(container, "Set them on", "Create from the newest");

    const { html, text } = copy(container);

    expect(text).toBe([
      "3. Set them on `create_sandbox`.",
      "4. **Create from the newest**",
    ].join("\n"));
    expect(html).toMatch(/^<ol start="3">/);
  });

  it("keeps nested bullets under their item", () => {
    const { container } = render(<ThreadMarkdown text={FEATURE_REQUEST} />);
    select(container, "Full lifecycle tools", "(change the TTL);");

    expect(copy(container).text).toBe([
      "2. **Full lifecycle tools in the MCP, so nothing needs the CLI:**",
      "   - `delete_sandbox` (most important for us);",
      "   - `extend_sandbox` (change the TTL);",
    ].join("\n"));
  });

  it("copies words from inside one item without its marker", () => {
    const { container } = render(<ThreadMarkdown text={FEATURE_REQUEST} />);
    select(container, "Labels on sandboxes", "Set them on");

    expect(copy(container).text).toBe(
      "**Labels on sandboxes and snapshots.** Set them on",
    );
  });

  it("drops a block the selection only touches at its start", () => {
    const { container } = render(<ThreadMarkdown text={FEATURE_REQUEST} />);
    // A triple-click selection ends at offset 0 of the next block.
    select(container, "We want agents", "Hosted MCP endpoint.", { endOffset: 0 });

    expect(copy(container).text).toBe(
      "We want agents to drive Sandboxer only through MCP: no `sbx` install, no CLI calls.",
    );
  });

  it("leaves a selection inside one text node to the browser", () => {
    const { container } = render(<ThreadMarkdown text={FEATURE_REQUEST} />);
    select(container, "drive Sandboxer", "only through");

    const { notPrevented, text } = copy(container);

    expect(notPrevented).toBe(true);
    expect(text).toBeUndefined();
  });

  it("copies code blocks, quotes, and tables as Markdown", () => {
    const markdown = [
      "Run:",
      "",
      "```sh",
      "pnpm test",
      "```",
      "",
      "> Quoted **note**",
      ">",
      "> - first",
      "> - second",
      "",
      "| Tool | Purpose |",
      "| --- | --- |",
      "| `delete_sandbox` | Clean up |",
      "| `extend_sandbox` | Change TTL |",
    ].join("\n");
    const { container } = render(<ThreadMarkdown text={markdown} />);
    select(container, "Run:", "Change TTL");

    expect(copy(container).text).toBe(markdown);
  });

  it("copies a selection across table cells as a table", () => {
    const markdown = [
      "| Tool | Purpose |",
      "| --- | --- |",
      "| `delete_sandbox` | Clean up |",
      "| `extend_sandbox` | Change TTL |",
    ].join("\n");
    const { container } = render(<ThreadMarkdown text={markdown} />);
    select(container, "Tool", "Change TTL");

    expect(copy(container).text).toBe(markdown);
  });

  it("keeps a mid-table selection under the table's own headers", () => {
    const markdown = [
      "| Tool | Purpose |",
      "| --- | --- |",
      "| `delete_sandbox` | Clean up |",
      "| `extend_sandbox` | Change TTL |",
    ].join("\n");
    const { container } = render(<ThreadMarkdown text={markdown} />);
    select(container, "Clean up", "Change TTL");

    expect(copy(container).text).toBe([
      "| Tool | Purpose |",
      "| --- | --- |",
      "|  | Clean up |",
      "| `extend_sandbox` | Change TTL |",
    ].join("\n"));
  });

  it("copies a Mermaid diagram as its source fence", () => {
    const markdown = [
      "Before",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
      "After",
    ].join("\n");
    // The diagram renders only once visible; it stays offscreen here.
    vi.stubGlobal("IntersectionObserver", class {
      disconnect() {}
      observe() {}
    });
    const { container } = render(<ThreadMarkdown text={markdown} />);
    // The rendered diagram is an image; the source must not depend on it.
    const diagram = container.querySelector(".mermaid-diagram")!;
    const image = document.createElement("img");
    image.src = "data:image/svg+xml;base64,AAAA";
    image.alt = "Mermaid diagram";
    diagram.append(image);
    select(container, "Before", "After");

    const { html, text } = copy(container);

    expect(text).toBe(markdown);
    expect(html).not.toContain("data:image");
  });

  it("drops a task item the selection only touches at its start", () => {
    const { container } = render(
      <ThreadMarkdown text={"Intro paragraph\n\n- [ ] todo item"} />,
    );
    select(container, "Intro", "todo item", { endOffset: 0 });

    expect(copy(container).text).toBe("Intro paragraph");
  });
});
