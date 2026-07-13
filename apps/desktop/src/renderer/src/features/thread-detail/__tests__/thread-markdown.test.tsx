import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadMarkdown } from "../ThreadMarkdown";

const sanitizedReviewFindingsTable = `| # | Sev | File | Issue | Fix |
|---:|:---:|---|---|---|
| 1 | P1 | [InvoiceDispatcher.scala (line 48)](/Users/ana/signal-shop/src/jvm/shared/public-api/src/main/scala/billing/invoice/InvoiceDispatcher.scala:48) | A retry-suppressed invoice falls through to the standard path because fallback only checks \`queuedInvoices.isEmpty\`. Why it matters: \`enforce=true\` can still make a second provider call and emit a duplicate notice after suppression was explicitly requested, so throttling does not reliably reduce calls or preserve invoice semantics. | Distinguish "normal no invoice ready" from terminal states like \`Retry suppressed\`; only fallback on intentional misses. |
| 2 | P2 | [LedgerWindow.scala (line 16)](/Users/ana/signal-shop/src/jvm/shared/public-api/src/main/scala/billing/window/LedgerWindow.scala:16) | \`LedgerIdentity\` drops \`tenantId\` when normalizing matched cache items. Why it matters: the existing cache counting treats \`(tenantId, accountId, periodId, bucketId)\` as the unique ledger identity, so two tenants with the same period/bucket ids are merged and can cross-throttle each other. | Include \`tenantId\` in \`LedgerIdentity\`, \`stableKey\`, sorting, and tests. |
| 3 | P2 | [AttemptObservation.scala (line 56)](/Users/ana/signal-shop/src/jvm/shared/public-api/src/main/scala/billing/window/AttemptObservation.scala:56) | \`observedCalls\` excludes failures, while \`Failure\` still counts as an attempted provider call. Why it matters: \`minObservedCalls\` is based on wins and losses only, so a failure-heavy bucket can remain sparse indefinitely and continue sending 100% of traffic during an outage pattern. | Use \`attempts\` for the minimum call threshold and keep win-ratio math on wins/losses, or rename the threshold and test failure-heavy behavior explicitly. |
| 4 | P2 | [InvoiceDispatcher.scala (line 87)](/Users/ana/signal-shop/src/jvm/shared/public-api/src/main/scala/billing/invoice/InvoiceDispatcher.scala:87) | The no-cache path always gives pacing an empty matched-account set, which becomes an allow-without-bucket decision. Why it matters: \`billing.enforce=true\` silently has no effect for \`createWithoutCache\` and no observations are accumulated even though pacing is enabled. | Fail fast or disable enforcement when the active-account cache is unavailable, or introduce a deliberate fallback bucket if no-cache pacing is expected to work. |
| 5 | P3 | [LedgerController.scala (line 72)](/Users/ana/signal-shop/src/jvm/shared/public-api/src/main/scala/billing/window/LedgerController.scala:72) | The deterministic sampling key is customer/page scoped and has no per-opportunity component. Why it matters: repeated requests from the same customer for the same bucket in one interval all make the same allow/throttle decision, and missing/shared customer ids can turn a configured probability into all-or-nothing behavior. | Include a stable opportunity/request identifier, or at least the full targeting tuple, in the sampling key and add tests for repeated same-customer requests. |`;

const malformedHandoffBody = [
  "We reproduced and fixed the upload bug.",
  "",
  "Root cause:",
  "The editor button still had a delegate and received mouseUp.",
  "",
  "Fix:",
  "In `GGEditorOptionsViewController.giphyButtonClicked(_:)`, handle upload by",
  "command/title as well as object identity:",
  "",
  "```swift",
  "} else if button === uploadButton || button.titleText == \"UPLOAD TO GIPHY\" {",
  "    uploadButtonClicked()",
  "}",
  "```",
  "",
  "Regression test:",
  "1. Creates several ready recordings.",
  "2. Sends mouseDown/mouseUp to the visible editor `UPLOAD TO GIPHY` button.",
  "3. Asserts the upload sheet opens.",
  "",
  "Related hardening:",
  "- Add diagnostic logs for upload button mouseUp.",
].join("\n");

const malformedHandoff = `\`\`\`text\n${malformedHandoffBody}\n\`\`\``;

describe("ThreadMarkdown", () => {
  it("renders markdown formatting and local file links", () => {
    render(
      <ThreadMarkdown
        text={"Use **bold** text and open [`ce:work`](/Users/huntharo/.codex/skills/ce-work/SKILL.md)."}
      />
    );

    expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ce:work" })).toHaveAttribute(
      "href",
      "file:///Users/huntharo/.codex/skills/ce-work/SKILL.md"
    );
    expect(screen.getByRole("link", { name: "ce:work" })).toHaveAttribute(
      "title",
      "Open in PwrAgent"
    );
  });

  it("opens local file links in the configured editor", async () => {
    const openApplication = vi.fn(async () => ({ opened: true as const }));

    render(
      <ThreadMarkdown
        applications={{
          editors: [
            {
              id: "vscode",
              kind: "editor",
              name: "VS Code",
              source: "application",
              appPath: "/Applications/Visual Studio Code.app",
              canOpenWorkspace: true,
            },
            {
              id: "zed",
              kind: "editor",
              name: "Zed",
              source: "application",
              appPath: "/Applications/Zed.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "zed", source: "config" },
          preferredTerminalId: { value: "", source: "default" },
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        desktopApi={{ openApplication }}
        text={"I updated [AGENTS.md](/repo/PwrAgent/AGENTS.md:17)."}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "AGENTS.md" }));

    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "zed",
        kind: "editor",
        targetPath: "/repo/PwrAgent/AGENTS.md",
        targetLine: 17,
        targetColumn: undefined,
      });
    });
  });

  it("opens markdown file links in a document modal and keeps the editor icon separate", async () => {
    const openApplication = vi.fn(async () => ({ opened: true as const }));
    const openMarkdownFileViewer = vi.fn(async () => ({ opened: true as const }));
    const readMarkdownFile = vi.fn(async (request: { path: string }) => ({
      path: request.path,
      content: "# AGENTS\n\nUse the repo guidance.",
    }));

    render(
      <ThreadMarkdown
        applications={{
          editors: [
            {
              id: "zed",
              kind: "editor",
              name: "Zed",
              source: "application",
              appPath: "/Applications/Zed.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "zed", source: "config" },
          preferredTerminalId: { value: "", source: "default" },
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        desktopApi={{ openApplication, openMarkdownFileViewer, readMarkdownFile }}
        fileViewerContext={{
          key: "codex:thread-1",
          title: "Files - Thread title",
          threadTitle: "Thread title",
          projectPath: "/repo/PwrAgent",
        }}
        text={"I updated [AGENTS.md](/repo/PwrAgent/AGENTS.md:17)."}
      />
    );

    expect(screen.getByRole("link", { name: "AGENTS.md" })).toHaveAttribute(
      "title",
      "Open in PwrAgent"
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open file in Zed: AGENTS.md" })
    );

    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "zed",
        kind: "editor",
        targetPath: "/repo/PwrAgent/AGENTS.md",
        targetLine: 17,
        targetColumn: undefined,
      });
    });

    openApplication.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "AGENTS.md" }));

    expect(await screen.findByRole("dialog", { name: "Markdown document: AGENTS.md" }))
      .toBeInTheDocument();
    expect(readMarkdownFile).toHaveBeenCalledWith({
      path: "/repo/PwrAgent/AGENTS.md",
    });
    expect(screen.getByRole("heading", { name: "AGENTS" })).toBeInTheDocument();
    expect(openApplication).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open in detached files window" }));

    await waitFor(() => {
      expect(openMarkdownFileViewer).toHaveBeenCalledWith({
        context: {
          key: "codex:thread-1",
          title: "Files - Thread title",
          threadTitle: "Thread title",
          projectPath: "/repo/PwrAgent",
        },
        editorApplication: expect.objectContaining({
          id: "zed",
          name: "Zed",
        }),
        file: {
          path: "/repo/PwrAgent/AGENTS.md",
          label: "AGENTS.md",
          line: 17,
          column: undefined,
        },
      });
    });
  });

  it("passes local file link line and column metadata to the configured editor", async () => {
    const openApplication = vi.fn(async () => ({ opened: true as const }));

    render(
      <ThreadMarkdown
        applications={{
          editors: [
            {
              id: "vscode",
              kind: "editor",
              name: "VS Code",
              source: "application",
              appPath: "/Applications/Visual Studio Code.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "vscode", source: "config" },
          preferredTerminalId: { value: "", source: "default" },
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        desktopApi={{ openApplication }}
        text={"Open [source](/repo/PwrAgent/src/main.ts:12:4)."}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "source" }));

    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "vscode",
        kind: "editor",
        targetPath: "/repo/PwrAgent/src/main.ts",
        targetLine: 12,
        targetColumn: 4,
      });
    });
  });

  it("keeps bare repo paths and domain-like markdown filenames as plain text", () => {
    const { container } = render(
      <ThreadMarkdown
        text={
          "Open docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md then notes.md and www.example.com."
        }
      />
    );

    expect(container).toHaveTextContent(
      "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md"
    );
    expect(container).toHaveTextContent("notes.md");
    expect(container).toHaveTextContent("www.example.com");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps explicit safe links clickable and rejects unsafe protocols", () => {
    render(
      <ThreadMarkdown
        text={
          "[Docs](https://example.com/docs) [Local](http://localhost:5173/status) [Plain HTTP](http://example.com) [Bad](javascript:alert(1))"
        }
      />
    );

    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://example.com/docs"
    );
    expect(screen.getByRole("link", { name: "Local" })).toHaveAttribute(
      "href",
      "http://localhost:5173/status"
    );
    expect(screen.queryByRole("link", { name: "Plain HTTP" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bad" })).not.toBeInTheDocument();
  });

  it("renders skill links as chips", () => {
    render(
      <ThreadMarkdown
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        text={"Load [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)"}
      />
    );

    expect(screen.getByText("$frontend-design")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "$frontend-design" })).not.toBeInTheDocument();
  });

  it("renders emoji, italic, strikethrough, and inline code", () => {
    render(
      <ThreadMarkdown
        text={"Calmer 😎 with *italic*, ~~struck~~, and `inline code`."}
      />
    );

    expect(screen.getByText("😎", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("italic", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("struck", { selector: "del" })).toBeInTheDocument();
    expect(
      screen.getByText("inline code", { selector: "code.transcript-message__code" })
    ).toBeInTheDocument();
  });

  it("preserves single newlines as visible line breaks", () => {
    const { container } = render(
      <ThreadMarkdown
        text={"Still Grok 4.\nWon't change no matter how many times you test.\nBuilt by xAI."}
      />
    );

    expect(container.querySelectorAll("br")).toHaveLength(2);
    expect(container).toHaveTextContent("Still Grok 4.");
    expect(container).toHaveTextContent("Built by xAI.");
  });

  it("renders thematic breaks between separate lists", () => {
    const { container } = render(
      <ThreadMarkdown
        text={[
          "- One",
          "- Two",
          "---",
          "- Second List - One",
          "- Second List - Two",
          "---",
          "- Third List - One",
          "- Third List - Two",
        ].join("\n")}
      />
    );

    expect(container.querySelectorAll("hr.transcript-message__rule")).toHaveLength(2);
    expect(container.querySelectorAll("ul.transcript-message__list")).toHaveLength(3);
    expect(screen.getByText("Second List - One")).toBeInTheDocument();
  });

  it("keeps composer-style hyphen-only bullet items visible", () => {
    const { container } = render(
      <ThreadMarkdown
        text={[
          "- One",
          "- Two",
          "- --",
          "- Three",
          "- Four",
          "- --",
          "- Five",
          "- Six",
        ].join("\n")}
      />
    );

    expect(container.querySelector("hr")).toBeNull();
    expect(container.querySelectorAll("ul.transcript-message__list")).toHaveLength(1);
    expect(screen.getAllByText("--")).toHaveLength(2);
  });

  it("renders html-looking transcript text literally", () => {
    const { container } = render(
      <ThreadMarkdown
        text={"Use <em>safe</em> markup and <table><tr><td>x</td></tr></table> literally."}
      />
    );

    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("<em>safe</em>");
    expect(container.textContent).toContain("<table><tr><td>x</td></tr></table>");
  });

  it("keeps markdown-looking syntax literal inside fenced code blocks", () => {
    const { container } = render(
      <ThreadMarkdown
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        text={
          "````md\n```ts\nconst marker = \"**not bold**\";\n```\n[$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)\n![Preview](https://example.com/inside-code.png)\n````"
        }
      />
    );

    const codeBlock = container.querySelector("pre code");
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.textContent).toContain("**not bold**");
    expect(codeBlock?.textContent).toContain("[$frontend-design]");
    expect(codeBlock?.textContent).toContain("![Preview](https://example.com/inside-code.png)");
    expect(container.querySelector("pre strong")).toBeNull();
    expect(container.querySelector("pre .skill-chip")).toBeNull();
    expect(container.querySelector("pre img")).toBeNull();
  });

  it("does not escape hyphen-only lines after shorter nested code fences", () => {
    const { container } = render(
      <ThreadMarkdown
        text={[
          "````md",
          "```ts",
          "const marker = true;",
          "```",
          "- --",
          "````",
        ].join("\n")}
      />
    );

    const codeBlock = container.querySelector("pre code");
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.textContent).toContain("```ts");
    expect(codeBlock?.textContent).toContain("- --");
    expect(codeBlock?.textContent).not.toContain("- \\--");
    expect(container.querySelector("hr")).toBeNull();
  });

  it("keeps malformed handoff messages grouped when they contain language fences", () => {
    const { container } = render(<ThreadMarkdown text={malformedHandoff} />);

    const codeBlocks = Array.from(container.querySelectorAll("pre code"));
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]?.textContent).toContain("```swift");
    expect(codeBlocks[0]?.textContent).toContain("Regression test:");
    expect(codeBlocks[0]?.textContent).toContain("Related hardening:");
    const paragraphText = Array.from(
      container.querySelectorAll(".transcript-message__paragraph")
    ).map((paragraph) => paragraph.textContent ?? "");
    expect(paragraphText.join("\n")).not.toContain("Regression test:");
  });

  it("copies repaired malformed handoff code without the outer wrapper", async () => {
    const copyText = vi.fn(async () => undefined);

    render(
      <ThreadMarkdown
        desktopApi={{ copyText }}
        text={malformedHandoff}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(`${malformedHandoffBody}\n`);
    });
  });

  it("does not collapse a valid code block followed by a separate language block", () => {
    const markdown = [
      "```",
      "literal nested-looking opener:",
      "```swift",
      "```",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");

    const { container } = render(<ThreadMarkdown text={markdown} />);

    const codeBlocks = Array.from(container.querySelectorAll("pre code"));
    expect(codeBlocks).toHaveLength(2);
    expect(codeBlocks[0]?.textContent).toContain("```swift");
    expect(codeBlocks[1]?.textContent).toContain("const answer = 42;");
  });

  it("copies fenced code blocks without markdown fences", async () => {
    const copyText = vi.fn(async () => undefined);

    render(
      <ThreadMarkdown
        desktopApi={{ copyText }}
        text={"```ts\nconst answer = 42;\n```"}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith("const answer = 42;\n");
    });
  });

  it("renders long fenced code blocks without expand controls", () => {
    const lines = Array.from({ length: 21 }, (_, index) => `line ${index + 1}`);

    const { container } = render(
      <ThreadMarkdown text={`\`\`\`txt\n${lines.join("\n")}\n\`\`\``} />
    );

    const codeBlock = container.querySelector("pre.transcript-message__pre");
    expect(codeBlock).toBeInTheDocument();
    expect(codeBlock).toHaveAttribute("aria-label", "Code block");
    expect(codeBlock).toHaveAttribute("tabindex", "0");
    expect(screen.queryByRole("button", { name: /Show full code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse code/ })).not.toBeInTheDocument();
  });

  it("copies blockquotes without quote markers", async () => {
    const copyText = vi.fn(async () => undefined);

    render(
      <ThreadMarkdown
        desktopApi={{ copyText }}
        text={"> Replay this prompt\n> exactly as written"}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy quote" }));

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith("Replay this prompt\nexactly as written");
    });
  });

  it("renders long blockquotes without expand controls", () => {
    const quote = Array.from(
      { length: 21 },
      (_, index) => `> quoted line ${index + 1}`
    ).join("\n");

    const { container } = render(<ThreadMarkdown text={quote} />);

    const blockquote = container.querySelector("blockquote.transcript-message__blockquote");
    expect(blockquote).toBeInTheDocument();
    expect(blockquote).toHaveAttribute("aria-label", "Quoted text");
    expect(blockquote).toHaveAttribute("tabindex", "0");
    expect(screen.queryByRole("button", { name: /Show full quote/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse quote/ })).not.toBeInTheDocument();
  });

  it("renders markdown image syntax as literal text instead of an image", () => {
    const { container } = render(
      <ThreadMarkdown
        text={"Keep ![Transcript preview](https://example.com/preview.png) inert for now."}
      />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(
      "![Transcript preview](https://example.com/preview.png)"
    );
  });

  it("renders wide review-style markdown tables with transcript table chrome", () => {
    const { container } = render(
      <ThreadMarkdown text={`## Findings\n\n${sanitizedReviewFindingsTable}`} />
    );

    const tableScroll = container.querySelector<HTMLDivElement>(
      ".thread-markdown__table-scroll"
    );
    const table = container.querySelector<HTMLTableElement>(".thread-markdown__table");

    expect(tableScroll).not.toBeNull();
    expect(table).not.toBeNull();
    expect(tableScroll).toContainElement(table);
    expect(container.querySelectorAll("th.thread-markdown__th")).toHaveLength(5);
    expect(container.querySelectorAll("td.thread-markdown__td")).toHaveLength(25);
    expect(screen.getByRole("columnheader", { name: "Issue" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Fix" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "InvoiceDispatcher.scala (line 48)" })
    ).toHaveAttribute(
      "href",
      "file:///Users/ana/signal-shop/src/jvm/shared/public-api/src/main/scala/billing/invoice/InvoiceDispatcher.scala:48"
    );
    expect(container).toHaveTextContent("Retry suppressed");
    expect(container).toHaveTextContent("failure-heavy behavior explicitly");
  });

  it("profiles review findings columns by content shape (tag / label / prose)", () => {
    const { container } = render(
      <ThreadMarkdown text={`## Findings\n\n${sanitizedReviewFindingsTable}`} />
    );

    const headerCellKinds = Array.from(
      container.querySelectorAll<HTMLTableCellElement>("thead th")
    ).map((cell) => cell.getAttribute("data-col-kind"));

    expect(headerCellKinds).toEqual(["tag", "tag", "label", "prose", "prose"]);

    const firstRowCellKinds = Array.from(
      container.querySelectorAll<HTMLTableCellElement>("tbody tr:first-child td")
    ).map((cell) => cell.getAttribute("data-col-kind"));

    expect(firstRowCellKinds).toEqual(["tag", "tag", "label", "prose", "prose"]);
  });

  it("profiles a generic wide table without applying review-findings sizing", () => {
    const { container } = render(
      <ThreadMarkdown
        text={`| Metric | North America | Europe | Asia Pacific |
|---|---|---|---|
| Request fingerprint | \`north-america-invoice-pacing-window-retry-suppressed-001\` | \`europe-invoice-pacing-window-retry-suppressed-002\` | \`asia-pacific-invoice-pacing-window-retry-suppressed-003\` |`}
      />
    );

    const headerCellKinds = Array.from(
      container.querySelectorAll<HTMLTableCellElement>("thead th")
    ).map((cell) => cell.getAttribute("data-col-kind"));

    // Metric column has a single short two-word value -> label.
    // Regional columns hold long unbroken identifiers -> prose.
    expect(headerCellKinds).toEqual(["label", "prose", "prose", "prose"]);
    expect(screen.getByRole("columnheader", { name: "Metric" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "North America" })).toBeInTheDocument();
  });

  it("classifies a compact key/value table as label/label", () => {
    const { container } = render(
      <ThreadMarkdown
        text={`| Key | Value |
|---|---|
| Mode | Shadow |
| Owner | Billing |`}
      />
    );

    const headerCellKinds = Array.from(
      container.querySelectorAll<HTMLTableCellElement>("thead th")
    ).map((cell) => cell.getAttribute("data-col-kind"));

    // 5-7 char values, single word -> label (not tag, since "Shadow"=6 chars > 4)
    expect(headerCellKinds).toEqual(["label", "label"]);
  });

  it("classifies short flag-like columns as tag", () => {
    const { container } = render(
      <ThreadMarkdown
        text={`| OK | Stat | Note |
|---|---|---|
| ✓ | P1 | Critical retry suppression issue blocking the rollout |
| ✗ | P2 | Cross-tenant identity merging detected by snapshot test |
| ✓ | P3 | Sampling key drift across repeat customer requests |`}
      />
    );

    const headerCellKinds = Array.from(
      container.querySelectorAll<HTMLTableCellElement>("thead th")
    ).map((cell) => cell.getAttribute("data-col-kind"));

    // ✓/✗ -> tag, P1/P2/P3 -> tag, long Note prose -> prose
    expect(headerCellKinds).toEqual(["tag", "tag", "prose"]);
  });

  it("skips raw html parsing for oversized html-like messages", () => {
    const oversizedHtml = "<em>safe</em>".repeat(2_000);
    const { container } = render(<ThreadMarkdown text={oversizedHtml} />);

    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<em>safe</em>");
  });

  it("renders composer directory references as chips", () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const { container } = render(
        <ThreadMarkdown
          text={
            "[@agent-kit](~/pwrdrvr/agent-kit) and "
            + "[@PwrAgnt](/Users/huntharo/pwrdrvr/PwrAgnt) are projects."
          }
        />
      );

      const chips = container.querySelectorAll(".directory-chip");
      expect(chips).toHaveLength(2);
      expect(chips[0]).toHaveTextContent("@agent-kit");
      expect(chips[0]).toHaveAttribute("data-tooltip", "~/pwrdrvr/agent-kit");
      expect(chips[1]).toHaveTextContent("@PwrAgnt");
      expect(
        screen.queryByRole("link", { name: "@agent-kit" })
      ).not.toBeInTheDocument();
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });
});
