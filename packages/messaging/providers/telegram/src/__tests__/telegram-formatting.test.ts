import { describe, expect, it } from "vitest";
import {
  buildTelegramKeyboard,
  escapeTelegramHtml,
  renderTelegramHtml,
  richMessageForTelegramIntent,
  richMessageForTelegramText,
  splitTelegramHtml,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  TELEGRAM_MESSAGE_TEXT_LIMIT,
  TELEGRAM_RICH_MESSAGE_TEXT_LIMIT,
  textForTelegramIntent,
} from "../telegram-formatting.ts";

describe("telegram formatting", () => {
  it("keeps bare repo plan paths as text instead of explicit links", () => {
    const planPath =
      "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md";
    const rendered = textForTelegramIntent({
      id: "message-1",
      kind: "message",
      createdAt: 1000,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `Use ${planPath} for the fix.`,
          markdown: "markdown",
        },
      ],
    });

    expect(rendered).toContain(planPath);
    expect(rendered).not.toContain("<a");
    expect(rendered).not.toContain("href=");
    expect(rendered).not.toContain(`http://${planPath}`);
    expect(rendered).not.toContain(`https://${planPath}`);
  });

  it("escapes HTML and preserves inline and fenced code as Telegram HTML", () => {
    const rendered = renderTelegramHtml(
      "Use `pnpm test` <now>\n\n```ts\nexpect(true).toBe(true)\n```",
      "markdown",
    );

    expect(rendered).toContain("Use <code>pnpm test</code> &lt;now&gt;");
    expect(rendered).toContain(
      "<pre><code class=\"language-ts\">expect(true).toBe(true)</code></pre>",
    );
  });

  it("labels regular and rich responses with the bound identity as escaped text", () => {
    const attribution = { label: "Agent: Breakfast <helper> & friends", hint: "  From\nDM  " };
    const intent = {
      id: "attributed", kind: "message" as const, createdAt: 1, attribution,
      parts: [{ type: "text" as const, text: "# Options", markdown: "markdown" as const }],
    };
    const label = "<i>Agent: Breakfast &lt;helper&gt; &amp; friends · From DM</i>";
    expect(textForTelegramIntent(intent)).toBe(`<b>Options</b>\n\n${label}`);
    expect(richMessageForTelegramIntent(intent)?.html).toBe(`<h1>Options</h1>\n<footer>${label}</footer>`);
    expect(textForTelegramIntent({
      id: "stream", kind: "stream_update", createdAt: 1, attribution,
      text: "# Options", markdown: "markdown",
      stream: { key: "options", sequence: 2, isFinal: true },
    })).toBe(`<b>Options</b>\n\n${label}`);
    expect(richMessageForTelegramText("# Options", "markdown", attribution)?.html)
      .toBe(`<h1>Options</h1>\n<footer>${label}</footer>`);
  });

  it("does not turn an empty response into an attribution-only message", () => {
    expect(splitTelegramHtml(textForTelegramIntent({
      id: "empty", kind: "message", createdAt: 1,
      attribution: { label: "Bound thread: Options" },
      parts: [{ type: "text", text: " \n\t" }],
    }))).toEqual([]);
  });

  it("splits long responses under Telegram message limits", () => {
    const chunks = splitTelegramHtml(
      `${"A".repeat(TELEGRAM_MESSAGE_TEXT_LIMIT - 10)}\n${"B".repeat(100)}`,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT)).toBe(
      true,
    );
  });

  it("omits chunks with only whitespace or empty formatting", () => {
    const chunks = splitTelegramHtml(`${"x".repeat(4090)}\n${" ".repeat(30)}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("x".repeat(4090));
    expect(splitTelegramHtml(`<b>${" ".repeat(5000)}</b>`)).toEqual([]);
    expect(splitTelegramHtml("<pre><code>\n\t </code></pre>")).toEqual([]);
    expect(splitTelegramHtml("<i>&#32;&#x20;</i>")).toEqual([]);
    expect(splitTelegramHtml(" \n\t")).toEqual([]);
    expect(splitTelegramHtml("<code>&lt; &amp;</code>")).toEqual(["<code>&lt; &amp;</code>"]);
  });

  it("preserves fenced code indentation inside nested list items", () => {
    const text = [
      "- Example",
      "  - YAML config",
      "",
      "    ```yaml",
      "    first: 1",
      "    second:",
      "      child: 2",
      "    ```",
      "",
      "    Continue after the code.",
    ].join("\n");
    const html = renderTelegramHtml(text, "markdown");
    expect(html).toContain("<pre><code class=\"language-yaml\">first: 1\nsecond:\n  child: 2</code></pre>");
    expect(html).toContain("\n    Continue after the code.");
  });

  it.each(["markdown", "light"] as const)("renders CommonMark inline formatting with the %s policy", (policy) => {
    expect(renderTelegramHtml(
      "**43 more downloads**, *italic*, __bold _nested___, ~~removed~~ and [release](https://example.com/?a=1&b=2)",
      policy,
    )).toBe("<b>43 more downloads</b>, <i>italic</i>, <b>bold <i>nested</i></b>, <s>removed</s> and <a href=\"https://example.com/?a=1&amp;b=2\">release</a>");
    expect(renderTelegramHtml("file_name and \\*literal\\* with **`code <x>`**", policy))
      .toBe("file_name and *literal* with <code>code &lt;x&gt;</code>");
  });

  it("renders headings, quotes and task lists without unsupported regular tags", () => {
    const rendered = renderTelegramHtml("# Release stats\n\n> **Counts** are cumulative.\n> Across releases.\n\n- [x] DMG\n- [ ] ZIP", "markdown");
    expect(rendered).toBe("<b>Release stats</b>\n\n<blockquote><b>Counts</b> are cumulative.\nAcross releases.</blockquote>\n\n☑ DMG\n☐ ZIP");
    expect(renderTelegramHtml("> outer\n>\n> > nested `code` and [link](https://example.com)", "markdown"))
      .toBe("<blockquote>outer\n\nnested code and link</blockquote>");
  });

  it("degrades a GFM table into labelled records readable on a phone", () => {
    const rendered = renderTelegramHtml([
      "| Asset | Downloads | Change |",
      "| :--- | ---: | ---: |",
      "| **mac updater ZIP** | 177 | +12 |",
      "| `stable PwrAgent.dmg` | 96 | +3 |",
    ].join("\n"), "markdown");
    expect(rendered).toBe("• <b>mac updater ZIP</b>\n  Downloads: 177\n  Change: +12\n\n• <code>stable PwrAgent.dmg</code>\n  Downloads: 96\n  Change: +3");
    expect(rendered).not.toContain("|");
    expect(rendered).not.toContain("<table");
    expect(renderTelegramHtml("Name | Value\n--- | ---\na\\|b | **2**", "markdown"))
      .toBe("• a|b\n  Value: <b>2</b>");
  });

  it("preserves fence languages and treats markup inside code as data", () => {
    expect(renderTelegramHtml("~~~python\nprint(\"**bold** <x>\")\n~~~", "markdown"))
      .toBe("<pre><code class=\"language-python\">print(\"**bold** &lt;x&gt;\")</code></pre>");
    expect(renderTelegramHtml("```js\nconst unfinished = \"<x>\";", "markdown"))
      .toBe("<pre><code class=\"language-js\">const unfinished = \"&lt;x&gt;\";</code></pre>");
    expect(renderTelegramHtml("```\"><b>\ntext\n```", "markdown"))
      .toBe("<pre><code>text</code></pre>");
  });

  it("escapes source HTML and refuses unsafe or oversized link attributes", () => {
    const rendered = renderTelegramHtml("<b>source</b> [unsafe](javascript:alert) [local](docs/file.md)", "markdown");
    expect(rendered).toBe("&lt;b&gt;source&lt;/b&gt; unsafe local");
    const largeUrl = `https://example.com/${"&".repeat(1000)}`;
    expect(renderTelegramHtml(`[label](${largeUrl})`, "markdown")).toBe("label");
    expect(renderTelegramHtml("**literal** | pipes | <b>", "plain"))
      .toBe("**literal** | pipes | &lt;b&gt;");
  });

  it.each(["markdown", "light"] as const)("keeps lexer-generated links as text with the %s policy", (policy) => {
    const text = "www.config.toml https://example.com/?a=1&b=2 person@example.com";
    const expected = "www.config.toml https://example.com/?a=1&amp;b=2 person@example.com";
    expect(renderTelegramHtml(text, policy)).toBe(expected);
    expect(richMessageForTelegramText(`# Files\n\n${text}`, policy)?.html)
      .toBe(`<h1>Files</h1>\n<p>${expected}</p>`);
    const explicit = "[file](https://example.com/file) <https://example.com/angle> [reference][ref]\n\n[ref]: https://example.com/ref";
    for (const html of [renderTelegramHtml(explicit, policy), richMessageForTelegramText(`# Links\n\n${explicit}`, policy)?.html]) {
      expect(html).toContain("<a href=\"https://example.com/file\">file</a>");
      expect(html).toContain("<a href=\"https://example.com/angle\">https://example.com/angle</a>");
      expect(html).toContain("<a href=\"https://example.com/ref\">reference</a>");
    }
  });

  it("splits formatted Unicode text without cutting entities or leaving tags unbalanced", () => {
    const html = renderTelegramHtml(`**${"🙂 & <".repeat(1000)}**\n\n\`\`\`python\n${"x < 2\n".repeat(900)}\`\`\``, "markdown");
    const chunks = splitTelegramHtml(html);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(TELEGRAM_MESSAGE_TEXT_LIMIT);
      const stack: string[] = [];
      for (const tag of chunk.matchAll(/<(\/)?([a-z]+)[^>]*>/g)) {
        if (tag[1]) expect(stack.pop()).toBe(tag[2]);
        else stack.push(tag[2]!);
      }
      expect(stack).toEqual([]);
      expect(chunk.replace(/<[^>]*>|&(?:amp|lt|gt|quot);/g, "")).not.toContain("&");
    }
    const withoutTags = (value: string) => value.replace(/<[^>]*>/g, "");
    expect(chunks.map(withoutTags).join("")).toBe(withoutTags(html));
  });

  it("builds rich HTML for native headings, compact aligned tables and checkboxes", () => {
    const rich = richMessageForTelegramText("# Stats\n\n| Asset | Count |\n| :--- | ---: |\n| ZIP | **177** |\n\n- [x] Checked\n- [ ] Pending", "markdown");
    expect(rich?.html).toContain("<h1>Stats</h1>");
    expect(rich?.html).toContain("<table bordered striped compact><tr><th align=\"left\">Asset</th><th align=\"right\">Count</th></tr><tr><td align=\"left\">ZIP</td><td align=\"right\"><b>177</b></td></tr></table>");
    expect(rich?.html).toContain("<li><input type=\"checkbox\" checked>Checked</li>");
    expect(rich?.html).toContain("<li><input type=\"checkbox\">Pending</li>");
    expect(richMessageForTelegramText("**Basic** formatting", "markdown")).toBeUndefined();
    expect(richMessageForTelegramText("# Plain heading", "plain")).toBeUndefined();
    expect(richMessageForTelegramText("```md\n# heading\n- [x] task\n```", "markdown")?.html)
      .toBe("<pre><code class=\"language-md\"># heading\n- [x] task</code></pre>");
  });

  it("keeps rich payloads within text, block, nesting and table-column limits", () => {
    expect(richMessageForTelegramText(`# Large\n\n${"x".repeat(32768)}`, "markdown")).toBeUndefined();
    expect(richMessageForTelegramText(Array.from({ length: 500 }, () => "# Heading").join("\n\n"), "markdown")).toBeDefined();
    expect(richMessageForTelegramText(Array.from({ length: 501 }, () => "# Heading").join("\n\n"), "markdown")).toBeUndefined();
    expect(richMessageForTelegramText(
      Array.from({ length: 500 }, () => "# Heading").join("\n\n"),
      "markdown", { label: "Agent: Options" },
    )).toBeUndefined();
    expect(richMessageForTelegramText("# Heading", "markdown", { label: "x".repeat(32768) })).toBeUndefined();
    expect(richMessageForTelegramText(Array.from({ length: 20 }, (_, index) => `${"  ".repeat(index)}- [ ] nested`).join("\n"), "markdown")).toBeUndefined();
    const table = (columns: number) => [
      Array.from({ length: columns }, () => "Cell").join(" | "),
      Array.from({ length: columns }, () => "---").join(" | "),
    ].join("\n");
    expect(richMessageForTelegramText(table(21), "markdown")).toBeUndefined();
    expect(richMessageForTelegramText(table(20), "markdown")).toBeDefined();
  });

  it.each(["x", "界", "🙂"])("allows exactly 32768 rendered characters for %s", (character) => {
    const text = character.repeat(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT);
    expect(richMessageForTelegramText(`# ${text}`, "markdown")?.html).toBe(`<h1>${text}</h1>`);
    expect(richMessageForTelegramText(`# ${text}${character}`, "markdown")).toBeUndefined();
  });

  it("excludes Markdown syntax, HTML tags and link destinations from the rich text budget", () => {
    const text = "x".repeat(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT);
    const url = `https://example.com/${"a".repeat(800)}`;
    expect(richMessageForTelegramText(`[**${text}**](${url})`, "markdown")?.html)
      .toBe(`<p><a href="${url}"><b>${text}</b></a></p>`);
    expect(richMessageForTelegramText(`[**${text}x**](${url})`, "markdown")).toBeUndefined();
    const combining = "e\u0301".repeat(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT / 2);
    expect(richMessageForTelegramText(`# ${combining}`, "markdown")).toBeDefined();
    expect(richMessageForTelegramText(`# ${combining}x`, "markdown")).toBeUndefined();
  });

  it("counts escaped text across parts and the attribution footer without block layout whitespace", () => {
    const text = "<>&".repeat(10922);
    const intent = {
      id: "rich-text-budget", kind: "message", createdAt: 1, role: "assistant",
      parts: [{ type: "text", text }, { type: "text", text: "<" }],
      attribution: { label: "🙂" },
    } satisfies Parameters<typeof richMessageForTelegramIntent>[0];
    expect(richMessageForTelegramIntent(intent)?.html)
      .toBe(`<p>${escapeTelegramHtml(text)}</p>\n<p>&lt;</p>\n<footer><i>🙂</i></footer>`);
    expect(richMessageForTelegramIntent({ ...intent, attribution: { label: "🙂x" } })).toBeUndefined();
  });

  it("counts native table cells, details summaries and formula source", () => {
    const text = "x".repeat(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT - 1);
    expect(richMessageForTelegramText(`| H |\n| --- |\n| ${text} |`, "markdown")).toBeDefined();
    expect(richMessageForTelegramText(`| H |\n| --- |\n| ${text}x |`, "markdown")).toBeUndefined();
    const details = (body: string) => `<details><summary>S</summary>\n\n$$\n${body}\n$$\n\n</details>`;
    expect(richMessageForTelegramText(details(text), "markdown")).toBeDefined();
    expect(richMessageForTelegramText(details(`${text}x`), "markdown")).toBeUndefined();
  });

  it("counts code and footnotes without fence syntax, languages or anchor attributes", () => {
    const code = "🙂".repeat(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT);
    expect(richMessageForTelegramText(`\`\`\`python\n${code}\n\`\`\``, "markdown")?.html)
      .toBe(`<pre><code class="language-python">${code}</code></pre>`);
    expect(richMessageForTelegramText(`\`\`\`python\n${code}x\n\`\`\``, "markdown")).toBeUndefined();
    const note = "x".repeat(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT - 8);
    expect(richMessageForTelegramText(`R[^a]\n\n[^a]: ${note}`, "markdown")).toBeDefined();
    expect(richMessageForTelegramText(`R[^a]\n\n[^a]: ${note}x`, "markdown")).toBeUndefined();
  });

  it("includes media captions in the shared rich text budget", () => {
    const intent = {
      id: "rich-caption-budget", kind: "message", createdAt: 1, role: "assistant",
      parts: [
        { type: "text", text: "x".repeat(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT - 1) },
        { type: "image", url: "https://example.com/photo.png", alt: "🙂" },
      ],
    } satisfies Parameters<typeof richMessageForTelegramIntent>[0];
    const media = [{ partIndex: 1, id: "part_1", media: { type: "photo" as const, media: "https://example.com/photo.png" } }];
    expect(richMessageForTelegramIntent(intent, media)).toBeDefined();
    expect(richMessageForTelegramIntent({
      ...intent, parts: [intent.parts[0]!, { type: "image", url: "https://example.com/photo.png", alt: "🙂x" }],
    }, media)).toBeUndefined();
  });

  it("uses rich delivery for code, quotes, lists and long answers", () => {
    for (const text of ["```ts\nconst result = 1;\n```", "> Quoted evidence", "- First\n- Second", "x".repeat(5000)]) {
      expect(richMessageForTelegramText(text, "markdown")).toBeDefined();
    }
    expect(richMessageForTelegramText("A short **answer**.", "markdown")).toBeUndefined();
  });

  it("renders nested details and expands their readable fallback", () => {
    const text = '<details open><summary>**Build evidence**</summary>\n\n- Passed\n\n<details><summary>Logs</summary>\n\n```html\n</details>\n<script>ignored</script>\n```\n\n</details>\n\n</details>';
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    expect(rich).toContain("<details open><summary><b>Build evidence</b></summary>");
    expect(rich).toContain("<details><summary>Logs</summary>");
    expect(rich).toContain('<pre><code class="language-html">&lt;/details&gt;\n&lt;script&gt;ignored&lt;/script&gt;</code></pre>');
    const regular = renderTelegramHtml(text, "markdown");
    expect(regular).toContain("<b>Build evidence</b>");
    expect(regular).toContain("• Passed");
    expect(regular).toContain("<b>Logs</b>");
    expect(regular).not.toContain("<details");
    expect(renderTelegramHtml('<details onclick="alert(1)"><summary>Title</summary>body</details>', "markdown"))
      .toContain('&lt;details onclick="alert(1)"&gt;');
    expect(renderTelegramHtml('<details><summary>unfinished</summary>', "markdown")).toContain("&lt;details&gt;");
    expect(renderTelegramHtml('<details><summary>literal</summary></details>', "plain")).toContain("&lt;details&gt;");
  });

  it.each(["regular", "rich"])("keeps block extension syntax literal inside %s inline code", (mode) => {
    const text = '# Code\n\nUse `<details><summary>X</summary></details>` and `echo $$` literally.\n\nUse `echo\n$$ x $$\nnow` too.';
    const html = mode === "rich" ? richMessageForTelegramText(text, "markdown")?.html : renderTelegramHtml(text, "markdown");
    expect(html).toContain('Use <code>&lt;details&gt;&lt;summary&gt;X&lt;/summary&gt;&lt;/details&gt;</code> and <code>echo $$</code> literally.');
    expect(html).toContain('Use <code>echo $$ x $$ now</code> too.');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("tg-math");
  });

  it("recognizes real details and math blocks after paragraphs", () => {
    const text = 'Before details.\n\n<details><summary>Title</summary>\n\nBody.\n\n</details>\n\nBefore math.\n\n$$\nx^2\n$$';
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    expect(rich).toContain('<p>Before details.</p>\n<details><summary>Title</summary><p>Body.</p></details>');
    expect(rich).toContain('<p>Before math.</p>\n<tg-math-block>x^2</tg-math-block>');
  });

  it.each(["    ", "\t"])("preserves details-body code indentation %j", (indent) => {
    const text = `<details><summary>Code</summary>\n\n \t\n${indent}**bold**\n${indent}$x$\n\n</details>`;
    for (const html of [renderTelegramHtml(text, "markdown"), richMessageForTelegramText(text, "markdown")?.html]) {
      expect(html).toContain('<pre><code>**bold**\n$x$</code></pre>');
      expect(html).not.toContain('<b>bold</b>');
      expect(html).not.toContain('tg-math');
    }
  });

  it("renders footnotes in first-use order and preserves unresolved source", () => {
    const text = 'Second[^b], first[^a], repeated[^b] and missing[^unknown].\n\n[^a]: **Alpha**\n[^b]: [Beta](https://example.com)\n    continued\n[^unused]: Keep this unused definition.';
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    expect(rich).toContain('Second<a href="#fn-1">[1]</a>, first<a href="#fn-2">[2]</a>');
    expect(rich).toContain('repeated<a href="#fn-1">[1]</a>');
    expect(rich).toContain('<tg-reference name="fn-1">[1] <a href="https://example.com">Beta</a>\ncontinued</tg-reference>');
    expect(rich).toContain('<tg-reference name="fn-2">[2] <b>Alpha</b></tg-reference>');
    expect(rich).toContain("missing[^unknown]");
    expect(rich).toContain("[^unused]: Keep this unused definition.");
    const regular = renderTelegramHtml(text, "markdown");
    expect(regular).toContain("Second[1], first[2], repeated[1]");
    expect(regular).toContain('[1] <a href="https://example.com">Beta</a>\ncontinued');
    expect(regular).not.toContain("tg-reference");
    expect(renderTelegramHtml('`[^a]`\n\n```md\n[^a]: source\n```', "markdown"))
      .toContain('<code>[^a]</code>');
  });

  it("does not resolve references inside unused footnote definitions", () => {
    const text = '# Notes\n\n[^unused]: See [^a].\n[^a]: Alpha';
    const regular = renderTelegramHtml(text, "markdown");
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    for (const html of [regular, rich]) {
      expect(html).toContain('[^unused]: See [^a].');
      expect(html).toContain('[^a]: Alpha');
      expect(html).not.toContain('[1]');
      expect(html).not.toContain('tg-reference');
    }
  });

  it("numbers rendered references before following reachable definitions", () => {
    const text = '[^unused]: Hidden [^d].\n[^a]: Alpha[^c].\n[^b]: Beta.\n[^c]: Gamma[^a].\n[^d]: Delta.\n\nFirst[^a], second[^b].';
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    expect(rich).toContain('First<a href="#fn-1">[1]</a>, second<a href="#fn-2">[2]</a>.');
    expect(rich).toContain('<tg-reference name="fn-1">[1] Alpha<a href="#fn-3">[3]</a>.</tg-reference>');
    expect(rich).toContain('<tg-reference name="fn-2">[2] Beta.</tg-reference>');
    expect(rich).toContain('<tg-reference name="fn-3">[3] Gamma<a href="#fn-1">[1]</a>.</tg-reference>');
    expect(rich).not.toContain('#fn-4');
    expect(rich).toContain('[^d]: Delta.');
    const regular = renderTelegramHtml(text, "markdown");
    expect(regular).toContain('First[1], second[2].');
    expect(regular).toContain('[1] Alpha[3].');
    expect(regular).toContain('[2] Beta.');
    expect(regular).toContain('[3] Gamma[1].');
    expect(regular).not.toContain('[4]');
  });

  it("keeps references in image alt text literal", () => {
    const text = '# Image\n\n![alt[^a]](https://example.com/photo.png)\n\n[^a]: Alpha';
    for (const html of [renderTelegramHtml(text, "markdown"), richMessageForTelegramText(text, "markdown")?.html]) {
      expect(html).toContain('alt[^a]');
      expect(html).toContain('[^a]: Alpha');
      expect(html).not.toContain('tg-reference');
      expect(html).not.toContain('[1]');
    }
  });

  it("does not close details on tags in multiline or indented code", () => {
    const text = '<details><summary>Code</summary>\n\n`first\ncode </details> code\nlast`\n\n    </details>\n\n```html\n``` not a closing fence\n</details>\n```\n\nActual end\n\n</details>';
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    expect(rich).toContain('<details><summary>Code</summary>');
    expect(rich).toContain('<code>first code &lt;/details&gt; code last</code>');
    expect(rich).toContain('<pre><code>&lt;/details&gt;</code></pre>');
    expect(rich).toContain('``` not a closing fence\n&lt;/details&gt;');
    expect(rich).toContain('<p>Actual end</p></details>');
  });

  it("resolves forward reference links in details summaries and footnotes", () => {
    const text = '<details><summary>[Source][ref]</summary>\n\nResult[^a].\n\n</details>\n\n[^a]: [Evidence][ref]\n\n[ref]: https://example.com/source';
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    expect(rich).toContain('<summary><a href="https://example.com/source">Source</a></summary>');
    expect(rich).toContain('<tg-reference name="fn-1">[1] <a href="https://example.com/source">Evidence</a></tg-reference>');
  });

  it("keeps footnote anchors unique across separate message parts", () => {
    const rich = richMessageForTelegramIntent({
      id: "notes", kind: "message", createdAt: 1,
      parts: ["First[^a].\n\n[^a]: Alpha", "Second[^a].\n\n[^a]: Beta"]
        .map((text) => ({ type: "text", text, markdown: "markdown" })),
    });
    expect(rich?.html).toContain('href="#part-0-fn-1"');
    expect(rich?.html).toContain('name="part-0-fn-1"');
    expect(rich?.html).toContain('href="#part-1-fn-1"');
    expect(rich?.html).toContain('name="part-1-fn-1"');
  });

  it("renders LaTeX without interpreting code or currency as formulas", () => {
    const text = 'Formula $x^2 < y^2$, costs $5 and $10, `$code$`, and \\$escaped.\n\n$$\nE = mc^2\n$$\n\n```math\n\\frac{a}{b}\n```';
    const rich = richMessageForTelegramText(text, "markdown")?.html;
    expect(rich).toContain('<tg-math>x^2 &lt; y^2</tg-math>');
    expect(rich).toContain('costs $5 and $10');
    expect(rich).toContain('<code>$code$</code>');
    expect(rich).toContain('$escaped');
    expect(rich).toContain('<tg-math-block>E = mc^2</tg-math-block>');
    expect(rich).toContain('<tg-math-block>\\frac{a}{b}</tg-math-block>');
    expect(renderTelegramHtml(text, "markdown")).toContain('<code>x^2 &lt; y^2</code>');
    expect(renderTelegramHtml(text, "markdown")).toContain('<pre><code>E = mc^2</code></pre>');
    expect(richMessageForTelegramText('Cost $5 and $10; unfinished $formula', "markdown")).toBeUndefined();
    expect(richMessageForTelegramText('Also \\(x^2\\).\n\n\\[\ny^2\n\\]', "markdown")?.html)
      .toContain('<p>Also <tg-math>x^2</tg-math>.</p>\n<tg-math-block>y^2</tg-math-block>');
  });

  it("preserves plain content parts and applies rich limits across all parts", () => {
    const intent = {
      id: "rich-parts", kind: "message", createdAt: 1,
      parts: [
        { type: "text", text: "# Stats", markdown: "markdown" },
        { type: "text", text: "**plain** <b> & data", markdown: "plain" },
      ],
    } satisfies Parameters<typeof richMessageForTelegramIntent>[0];
    expect(richMessageForTelegramIntent(intent)?.html).toContain("<p>**plain** &lt;b&gt; &amp; data</p>");
    expect(richMessageForTelegramIntent({ ...intent, parts: [...intent.parts, { type: "text", text: "x".repeat(32768) }] })).toBeUndefined();
    expect(richMessageForTelegramIntent({ ...intent, parts: [...intent.parts, { type: "image", url: "https://example.com/photo.png" }] })).toBeUndefined();
  });

  it("builds one-button rows with compact opaque callback handles", () => {
    const keyboard = buildTelegramKeyboard(
      [
        {
          id: "bind:codex:a-very-long-thread-identifier-that-would-not-fit-everywhere",
          label: "1. Long thread",
          value: {
            backend: "codex",
            threadId: "thread",
          },
        },
      ],
      () => "tg:abcdefghijklmnopqr",
    );

    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          {
            text: "1. Long thread",
            callback_data: "tg:abcdefghijklmnopqr",
          },
        ],
      ],
    });
    expect(Buffer.byteLength(keyboard!.inline_keyboard[0]![0]!.callback_data, "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
  });

  it("honors explicit channel-neutral button rows", () => {
    const keyboard = buildTelegramKeyboard(
      [
        {
          id: "one",
          label: "One",
          layout: { row: 0, column: 0 },
        },
        {
          id: "two",
          label: "Two",
          layout: { row: 0, column: 1 },
        },
        {
          id: "three",
          label: "Three",
          layout: { row: 1, column: 0 },
        },
      ],
      () => "tg:abcdefghijklmnopqr",
    );

    expect(keyboard?.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["One", "Two"],
      ["Three"],
    ]);
  });

  it("honors channel-neutral automatic column hints", () => {
    const keyboard = buildTelegramKeyboard(
      [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
        { id: "three", label: "Three" },
      ],
      () => "tg:abcdefghijklmnopqr",
      { columns: 2 },
    );

    expect(keyboard?.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["One", "Two"],
      ["Three"],
    ]);
  });

  it("renders workspace handoff choices with opaque callback handles", () => {
    const intent = {
      id: "handoff-overview-1",
      kind: "single_select",
      createdAt: 1000,
      prompt: [
        "Workspace Handoff",
        "Repository: /repo/pwragent",
        "Working directory: /repo/pwragent",
        "Branch: feature/handoff",
      ].join("\n"),
      fallbackText: "Reply with 1, Back, Refresh, or Cancel.",
      choices: [
        {
          id: "handoff:local-to-worktree",
          label: "Handoff to New Worktree",
          style: "primary",
          fallbackText: "1",
          value: {
            backend: "codex",
            threadId: "thread-1",
            direction: "local-to-worktree",
            repositoryPath: "/repo/pwragent",
            sourcePath: "/repo/pwragent",
            sourceBranch: "feature/handoff",
          },
        },
        {
          id: "handoff:cancel",
          label: "Cancel",
          style: "secondary",
          fallbackText: "cancel",
        },
      ],
    } satisfies Parameters<typeof textForTelegramIntent>[0];

    const keyboard = buildTelegramKeyboard(
      intent.choices,
      () => "tg:abcdefghijklmnopqr",
    );

    expect(textForTelegramIntent(intent)).toContain("Workspace Handoff");
    expect(keyboard?.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["Handoff to New Worktree"],
      ["Cancel"],
    ]);
    expect(JSON.stringify(keyboard)).not.toContain("/repo/pwragent");
  });

  it("escapes plain text without introducing formatting", () => {
    expect(escapeTelegramHtml("a < b && b > c")).toBe(
      "a &lt; b &amp;&amp; b &gt; c",
    );
  });

  it("renders approval code blocks as Telegram HTML", () => {
    const rendered = textForTelegramIntent({
      id: "approval-1",
      kind: "approval",
      createdAt: 1000,
      title: "Command Approval",
      body: "Command:\n```shell\npnpm test\n```",
      decisions: [],
    });

    expect(rendered).toContain("Command Approval");
    expect(rendered).toContain("<pre><code class=\"language-shell\">pnpm test</code></pre>");
  });

  it("renders generated tool update messages as ordinary escaped chat text", () => {
    const rendered = textForTelegramIntent({
      id: "tool-update-1",
      kind: "message",
      createdAt: 1000,
      role: "system",
      parts: [
        {
          type: "text",
          text: "Tool update: npm view <dive>",
          markdown: "light",
        },
      ],
    });

    expect(rendered).toBe("Tool update: npm view &lt;dive&gt;");
  });

  it("renders status actions with caller-provided opaque callback handles", () => {
    const keyboard = buildTelegramKeyboard(
      [
        {
          id: "status:tool-updates",
          label: "Tools: Show Some",
          fallbackText: "tools",
          style: "secondary",
        },
      ],
      () => "tg:abcdefghijklmnopqr",
    );

    expect(keyboard?.inline_keyboard).toEqual([
      [
        {
          text: "Tools: Show Some",
          callback_data: "tg:abcdefghijklmnopqr",
        },
      ],
    ]);
  });

  it("rejects semantic ids in Telegram callback_data", () => {
    expect(() =>
      buildTelegramKeyboard(
        [
          {
            id: "status:streaming",
            label: "Stream: Default",
          },
        ],
        (action) => `tg:${action.id}`,
      ),
    ).toThrow("Telegram callback_data must be an opaque persisted handle.");
  });
});
