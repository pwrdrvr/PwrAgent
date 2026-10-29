import { describe, expect, it } from "vitest";
import {
  LINEAR_PASTED_IMAGE_LIMIT,
  findLinearPastedImages,
  isLinearMcpServerUrl,
  mayContainLinearPastedImages,
  normalizeLinearUploadUrl,
  parseLinearPaste,
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

describe("parseLinearPaste", () => {
  const ISSUE = [
    '<issue identifier="PWR-5">',
    "<title>Mark Read hotkey in &quot;Attention&quot; lens</title>",
    "<description>",
    "## Report",
    "",
    "The hotkey does nothing.",
    tag(`${FILE}?signature=x`, "attention-lens.png"),
    "Expected it to clear the cookie.",
    "</description>",
    '<team name="PwrDrvr"/>',
    "<label>Bug</label>",
    '<label name="Desktop"/>',
    '<project name="PwrAgent &amp; friends"></project>',
    "</issue>",
  ].join("\n");

  it("lays out a full copied issue: header, description, and named images", () => {
    expect(parseLinearPaste(`Please fix this.\n\n${ISSUE}\n\nThanks`)).toEqual({
      before: "Please fix this.",
      issue: {
        identifier: "PWR-5",
        title: 'Mark Read hotkey in "Attention" lens',
        team: "PwrDrvr",
        project: "PwrAgent & friends",
        labels: ["Bug", "Desktop"],
      },
      body: [
        { type: "markdown", text: "## Report\n\nThe hotkey does nothing." },
        { type: "image", name: "attention-lens.png" },
        { type: "markdown", text: "Expected it to clear the cookie." },
      ],
      after: "Thanks",
    });
  });

  it("lays out a copied description with no issue wrapper", () => {
    expect(parseLinearPaste(`Before\n${tag(FILE, undefined, "")}\nAfter`)).toEqual({
      before: "",
      body: [
        { type: "markdown", text: "Before" },
        { type: "image" },
        { type: "markdown", text: "After" },
      ],
      after: "",
    });
  });

  it("reads an attribute by its own name, not a hyphenated one", () => {
    expect(parseLinearPaste(
      '<issue identifier="PWR-7"><title>T</title><project display-name="Old" name="New"/></issue>',
    )?.issue?.project).toBe("New");
  });

  it("keeps anything else inside the wrapper visible", () => {
    const layout = parseLinearPaste(
      '<issue identifier="PWR-6"><title>T</title><comments><comment>Hi</comment></comments></issue>',
    );

    expect(layout?.body).toEqual([
      { type: "markdown", text: "<comments><comment>Hi</comment></comments>" },
    ]);
  });

  it("leaves malformed and unrelated text alone", () => {
    for (const text of [
      "plain words",
      "<issues>not ours</issues>",
      '<issue identifier="PWR-5"><title>Unclosed</title>',
      "<issue><description>No title or identifier</description></issue>",
      `${ISSUE}\n${ISSUE}`,
    ]) {
      expect(parseLinearPaste(text), text).toBeUndefined();
    }
  });

  it("leaves tags quoted as code alone", () => {
    expect(parseLinearPaste(`Linear writes:\n\n\`\`\`\n${ISSUE}\n\`\`\``)).toBeUndefined();
    expect(parseLinearPaste(`It is \`${tag(FILE)}\` here`)).toBeUndefined();
    expect(parseLinearPaste(`It is \`see ${tag(FILE)}\` here`)).toBeUndefined();
  });
});
