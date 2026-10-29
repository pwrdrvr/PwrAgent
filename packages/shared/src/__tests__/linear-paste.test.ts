import { describe, expect, it } from "vitest";
import {
  LINEAR_PASTED_IMAGE_LIMIT,
  findLinearPastedImages,
  isLinearMcpServerUrl,
  mayContainLinearPastedImages,
  normalizeLinearUploadUrl,
} from "../linear-paste";

const FILE = "https://uploads.linear.app/org-1/issue-2/file-3";

function tag(src: string, alt?: string, attrs = ' quality="preview"'): string {
  return `<linear-image${attrs}>${JSON.stringify({
    type: "image",
    attrs: { src, ...(alt === undefined ? {} : { alt }) },
  })}</linear-image>`;
}

describe("findLinearPastedImages", () => {
  it("reads a copied prompt's image, keeping its signed link beside the file identity", () => {
    const text = [
      '<issue identifier="PWR-5"> <title>Mark Read hotkey</title> <description>',
      "## Report",
      tag(`${FILE}?signature=eyJ.abc.def`, "attention-lens-mark-read.png"),
      "</description> </issue>",
    ].join("\n");

    expect(findLinearPastedImages(text)).toEqual([{
      url: FILE,
      signedUrl: `${FILE}?signature=eyJ.abc.def`,
      alt: "attention-lens-mark-read.png",
    }]);
  });

  it("reads a tag with no attributes, as the MCP returns it", () => {
    expect(findLinearPastedImages(tag(FILE, undefined, ""))).toEqual([{ url: FILE }]);
  });

  it("reads Markdown images on uploads.linear.app, in paste order", () => {
    const text = `![first](${FILE}-a?signature=x)\n${tag(`${FILE}-b`, "second")}\n![third](${FILE}-c)`;

    expect(findLinearPastedImages(text).map((image) => image.alt)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("ignores other hosts, plain http, and malformed nodes", () => {
    const text = [
      tag("https://uploads.linear.app.evil.example/x"),
      tag("http://uploads.linear.app/x"),
      tag("https://user@uploads.linear.app/x"),
      tag("https://uploads.linear.app/"),
      "<linear-image>{not json}</linear-image>",
      '<linear-image>{"type":"image"}</linear-image>',
      "![x](https://example.com/uploads.linear.app/y)",
    ].join("\n");

    expect(findLinearPastedImages(text)).toEqual([]);
  });

  it("lists a file once however many times it appears", () => {
    const text = `${tag(`${FILE}?signature=a`, "one")}${tag(`${FILE}?signature=b`, "two")}`;

    expect(findLinearPastedImages(text)).toEqual([
      { url: FILE, signedUrl: `${FILE}?signature=a`, alt: "one" },
    ]);
  });

  it("takes the signature from a later copy when the first had none", () => {
    const text = `${tag(FILE, "one")}![two](${FILE}?x=1&signature=late)`;

    expect(findLinearPastedImages(text)).toEqual([
      { url: FILE, signedUrl: `${FILE}?signature=late`, alt: "one" },
    ]);
  });

  it("ignores a signature that is only in the fragment", () => {
    expect(findLinearPastedImages(tag(`${FILE}#signature=nope`))).toEqual([{ url: FILE }]);
  });

  it("caps one paste", () => {
    const text = Array.from(
      { length: LINEAR_PASTED_IMAGE_LIMIT + 3 },
      (_, index) => tag(`${FILE}-${index}`),
    ).join("\n");

    expect(findLinearPastedImages(text)).toHaveLength(LINEAR_PASTED_IMAGE_LIMIT);
  });

  it("flattens control characters out of a name", () => {
    expect(findLinearPastedImages(tag(FILE, "a\nb\tc"))).toEqual([
      { url: FILE, alt: "a b c" },
    ]);
  });
});

describe("Linear URL predicates", () => {
  it("keeps only the file identity of an upload URL", () => {
    expect(normalizeLinearUploadUrl(`${FILE}?signature=a#frag`)).toBe(FILE);
    expect(normalizeLinearUploadUrl("https://uploads.linear.app:8443/x")).toBeUndefined();
    expect(normalizeLinearUploadUrl("not a url")).toBeUndefined();
  });

  it("recognizes Linear's hosted MCP server", () => {
    expect(isLinearMcpServerUrl("https://mcp.linear.app/mcp")).toBe(true);
    expect(isLinearMcpServerUrl("https://mcp.linear.app/sse")).toBe(true);
    expect(isLinearMcpServerUrl("http://mcp.linear.app/mcp")).toBe(false);
    expect(isLinearMcpServerUrl("https://mcp.linear.app.example/mcp")).toBe(false);
  });

  it("skips the parse for text with no Linear content", () => {
    expect(mayContainLinearPastedImages("hello")).toBe(false);
    expect(mayContainLinearPastedImages("<linear-image>")).toBe(true);
  });
});
