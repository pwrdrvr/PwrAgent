import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilePreviewBody, FilePreviewCopyButton } from "../FilePreview";

function shownText(container: HTMLElement): string {
  return [...container.querySelectorAll(".file-preview__text")]
    .map((line) => line.textContent)
    .join("\n");
}

describe("file preview", () => {
  it("shows multi-line JSON as written, with literals preserved and highlighted", () => {
    const content = '{\n  "id": 9007199254740993,\n  "id": 1e+30,\n  "files": ["dist", "README.md"],\n  "text": "brace } comma , quote \\" and \\u0061",\n  "ok": true\n}';
    const { container } = render(<FilePreviewBody content={content} kind="json" />);
    expect(shownText(container)).toBe(content);
    expect(container.querySelectorAll(".file-preview__line")).toHaveLength(7);
    expect(container.querySelector(".file-preview__token--key")).toHaveTextContent('"id"');
    expect(container.querySelector(".file-preview__token--number")).toHaveTextContent("9007199254740993");
    expect(container.querySelector(".file-preview__token--string")).toHaveTextContent('"dist"');
    expect(container.querySelector(".file-preview__token--literal")).toHaveTextContent("true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("formats single-line JSON for reading and says the lines no longer match", () => {
    const content = '{"id":"fx-1","tags":["a"],"empty":{}}';
    const { container } = render(<FilePreviewBody content={content} kind="json" targetLine={2} />);
    expect(shownText(container)).toBe('{\n  "id": "fx-1",\n  "tags": [\n    "a"\n  ],\n  "empty": {}\n}');
    expect(screen.getByRole("status")).toHaveTextContent("Formatted for reading. The file is a single line.");
    expect(container.querySelector('[data-state="target"]')).toBeNull();
  });

  it.each(["null", "false", "42", '"a string"', "[]", "{}"])("renders a JSON root value as written: %s", (content) => {
    const { container } = render(<FilePreviewBody content={content} kind="json" />);
    expect(shownText(container)).toBe(content);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("accepts JSON with comments and trailing commas without an error", () => {
    const content = '{\n  // Shared settings.\n  "compilerOptions": {\n    "strict": true, /* block */\n  },\n}';
    const { container } = render(<FilePreviewBody content={content} kind="json" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(shownText(container)).toBe(content);
    expect(container.querySelector(".file-preview__token--comment")).toHaveTextContent("// Shared settings.");
    expect(container.querySelector(".file-preview__token--key")).toHaveTextContent('"compilerOptions"');
  });

  it("locates invalid JSON and marks the line", () => {
    const content = '{\n  "region": "us-west-2",\n  "replicas": 3\n  "zones": ["a"]\n}';
    const { container } = render(<FilePreviewBody content={content} kind="json" />);
    expect(screen.getByRole("status")).toHaveTextContent("Invalid JSON at line 4, column 3.");
    expect(shownText(container)).toBe(content);
    expect(container.querySelector('[data-state="error"]')).toHaveAttribute("data-line", "4");
  });

  it("locates truncated JSON on its last line, not past a final newline", () => {
    const { container } = render(<FilePreviewBody content={'{\n  "broken": [1,\n'} kind="json" />);
    expect(screen.getByRole("status")).toHaveTextContent("Invalid JSON at line 2,");
    expect(container.querySelector('[data-state="error"]')).toHaveAttribute("data-line", "2");
  });

  it.each(["", '{"broken":', '<script>alert("example")</script>'])("shows invalid JSON as escaped original text: %s", (content) => {
    const { container } = render(<FilePreviewBody content={content} kind="json" />);
    expect(screen.getByRole("status")).toHaveTextContent("Invalid JSON");
    expect(shownText(container)).toBe(content);
    expect(container.querySelector("script")).toBeNull();
  });

  it("escapes HTML within highlighted JSON strings", () => {
    const { container } = render(<FilePreviewBody content={'{\n"text": "<script>alert(1)</script>"\n}'} kind="json" />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".file-preview__token--string")).toHaveTextContent("<script>alert(1)</script>");
  });

  it("keeps a single-line document as written when formatting would exceed its bound", () => {
    const content = "[".repeat(50) + "[0],".repeat(40000).slice(0, -1) + "]".repeat(50);
    const { container } = render(<FilePreviewBody content={content} kind="json" />);
    expect(shownText(container)).toBe(content);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("drops syntax elements past the token bound and keeps the gutter", () => {
    const content = `[\n${"  1,\n".repeat(12000)}  1\n]`;
    const { container } = render(<FilePreviewBody content={content} kind="json" />);
    expect(container.querySelectorAll(".file-preview__text span")).toHaveLength(0);
    expect(container.querySelectorAll(".file-preview__line")).toHaveLength(12003);
    expect(shownText(container)).toBe(content);
  });

  it("renders a file past the row bound as one block without a gutter", () => {
    const content = "line\n".repeat(20001);
    const { container } = render(<FilePreviewBody content={content} kind="text" />);
    expect(container.querySelector(".file-preview__line")).toBeNull();
    expect(screen.getByRole("region", { name: "Text contents" }).textContent).toBe(content);
  });

  it("highlights and scrolls to the linked line", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { container } = render(<FilePreviewBody content={"a\nb\nc"} kind="text" targetLine={2} />);
      const target = container.querySelector('[data-state="target"]');
      expect(target).toHaveAttribute("data-line", "2");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      expect(scrollIntoView.mock.contexts[0]).toBe(target);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("does not number an empty line after the final newline", () => {
    const { container } = render(<FilePreviewBody content={"a\nb\n\n"} kind="text" />);
    expect([...container.querySelectorAll(".file-preview__line")].map((line) => line.getAttribute("data-line")))
      .toEqual(["1", "2", "3"]);
  });

  it("ignores a linked line beyond the end of the file", () => {
    const { container } = render(<FilePreviewBody content={"a\nb"} kind="text" targetLine={9} />);
    expect(container.querySelector('[data-state="target"]')).toBeNull();
  });

  it("marks JSON Lines records that do not parse", () => {
    const content = '{"event":"start"}\n{"event":"step"\n\n{"event":"done"}\nnot json';
    const { container } = render(<FilePreviewBody content={content} kind="jsonl" />);
    expect(screen.getByRole("status")).toHaveTextContent("2 lines are not valid JSON: 2, 5.");
    expect([...container.querySelectorAll('[data-state="error"]')].map((line) => line.getAttribute("data-line")))
      .toEqual(["2", "5"]);
    expect(shownText(container)).toBe(content);
  });

  it("colors YAML keys, values, and comments", () => {
    const content = "# settings\nservice:\n  replicas: 3\n  debug: false\n  region: \"us-west-2\" # primary\n  script: |\n    echo: not a key\n  zones:\n    - a";
    const { container } = render(<FilePreviewBody content={content} kind="yaml" />);
    expect(shownText(container)).toBe(content);
    const kinds = (kind: string) => [...container.querySelectorAll(`.file-preview__token--${kind}`)].map((token) => token.textContent);
    expect(kinds("key")).toEqual(["service", "replicas", "debug", "region", "script", "zones"]);
    expect(kinds("comment")).toEqual(["# settings", "# primary"]);
    expect(kinds("number")).toEqual(["3"]);
    expect(kinds("literal")).toEqual(["false"]);
    expect(kinds("string")).toEqual(['"us-west-2"', "    echo: not a key"]);
  });

  it("colors TOML tables, keys, values, and multi-line strings", () => {
    const content = "[project]\nname = \"example\"\nreleased = 2026-10-06\ndescription = \"\"\"\nkey = not a key\n\"\"\"\n[[tool.list]]\nenabled = true # on";
    const { container } = render(<FilePreviewBody content={content} kind="toml" />);
    expect(shownText(container)).toBe(content);
    const kinds = (kind: string) => [...container.querySelectorAll(`.file-preview__token--${kind}`)].map((token) => token.textContent);
    expect(kinds("section")).toEqual(["[project]", "[[tool.list]]"]);
    expect(kinds("key")).toEqual(["name", "released", "description", "enabled"]);
    expect(kinds("string")).toEqual(['"example"', '"""', "key = not a key", '"""']);
    expect(kinds("number")).toEqual(["2026-10-06"]);
    expect(kinds("literal")).toEqual(["true"]);
    expect(kinds("comment")).toEqual(["# on"]);
  });

  it("keeps the rows of a multi-line TOML array out of the table headers", () => {
    const content = "matrix = [\n  [1, 2],\n  [3, 4],\n]\n[next]";
    const { container } = render(<FilePreviewBody content={content} kind="toml" />);
    expect([...container.querySelectorAll(".file-preview__token--section")].map((token) => token.textContent))
      .toEqual(["[next]"]);
    expect(container.querySelectorAll(".file-preview__token--number")).toHaveLength(4);
  });

  it("treats quotes in TSV as text", () => {
    const content = 'size\tnote\n5"\t"open quote\n7\tok';
    render(<FilePreviewBody content={content} kind="tsv" />);
    const cells = [...screen.getByRole("region", { name: "TSV contents" }).querySelectorAll("tbody td")]
      .map((cell) => cell.textContent);
    expect(cells).toEqual(['5"', '"open quote', "7", "ok"]);
  });

  it("renders CSV as a table with quoted fields and right-aligned numbers", () => {
    const content = 'region,p50_ms,note\nus-west-2,41,"quoted, with comma"\neu-central-1,"1,057","line one\nline two"\n';
    render(<FilePreviewBody content={content} kind="csv" />);
    const table = screen.getByRole("region", { name: "CSV contents" });
    expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["region", "p50_ms", "note"]);
    const cells = [...table.querySelectorAll("tbody td")].map((cell) => cell.textContent);
    expect(cells).toEqual(["us-west-2", "41", "quoted, with comma", "eu-central-1", "1,057", "line one\nline two"]);
    expect(table.querySelectorAll('td[data-numeric="true"]')).toHaveLength(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders TSV and states when rows are capped", () => {
    const content = `name\tcount\n${"row\t1\n".repeat(1200)}`;
    render(<FilePreviewBody content={content} kind="tsv" />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 1,000 of 1,200 rows.");
    expect(screen.getByRole("region", { name: "TSV contents" }).querySelectorAll("tbody tr")).toHaveLength(1000);
  });

  it("falls back to text for CSV with an unterminated quote", () => {
    const content = 'a,b\n1,"open\n2,3';
    const { container } = render(<FilePreviewBody content={content} kind="csv" />);
    expect(screen.getByRole("status")).toHaveTextContent("Not readable as CSV. Showing the file as written.");
    expect(shownText(container)).toBe(content);
  });

  it.each([
    ["json", "Copy JSON"],
    ["markdown", "Copy Markdown"],
    ["jsonl", "Copy JSON Lines"],
    ["yaml", "Copy YAML"],
    ["toml", "Copy TOML"],
    ["csv", "Copy CSV"],
    ["text", "Copy text"],
  ] as const)("copies %s source as written", async (kind, label) => {
    const copyText = vi.fn(async () => undefined);
    render(<FilePreviewCopyButton content={"{ }"} desktopApi={{ copyText, copyRichText: vi.fn() }} kind={kind} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(await screen.findByRole("button", { name: label.replace("Copy", "Copied") })).toBeInTheDocument();
    expect(copyText).toHaveBeenCalledWith("{ }");
  });
});
