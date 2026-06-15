import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

// Regression coverage for composer markdown paste. The bug these guard against:
// a code fence used to flip paste off Tiptap's HTML-aware default path onto a
// plain-text-only markdown reparse. When a clipboard's text/plain flattens
// paragraph breaks to single newlines (structure living only in text/html),
// that flip collapsed prose paragraphs into one block — but ONLY when a code
// block was present. The visible symptom was "the blank line above Fix: /
// Root cause: disappears once you include the Swift code block." A pure jsdom
// test cannot catch this: fireEvent.paste never runs the real-browser
// text/html-vs-text/plain clipboard arbitration. These run in real Electron.

async function createPasteFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-md-paste-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const fixturePath = path.join(rootDir, "md-paste.fixture.json");
  await mkdir(repoDir, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PwrAgent Tests",
      "-c",
      "user.email=pwragent-tests@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Seed fixture repo",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );

  const existingThread = {
    id: "thread-existing",
    title: "Existing draft parking thread",
    titleSource: "explicit",
    summary: "Existing thread for markdown paste",
    source: "codex",
    executionMode: "default",
    linkedDirectories: [
      { id: "fixture-repo", label: "FixtureRepo", path: repoDir, kind: "local" },
    ],
    updatedAt: 2_000,
  };
  const threadReadResult = {
    entries: [
      { type: "message", id: "existing-message-1", role: "assistant", text: "Ready." },
    ],
    messages: [{ id: "existing-message-1", role: "assistant", text: "Ready." }],
    lastAssistantMessage: "Ready.",
    pagination: { supportsPagination: false, hasPreviousPage: false },
  };

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: { backend: "codex", scenario: "composer-markdown-paste" },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "turn/start"],
            },
          },
          { id: "thread-list-1", kind: "response", method: "thread/list", result: [existingThread] },
          { id: "thread-read-1", kind: "response", method: "thread/read", result: threadReadResult },
          { id: "thread-read-2", kind: "response", method: "thread/read", result: threadReadResult },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function openExistingThread(app: Awaited<ReturnType<typeof launchElectronApp>>) {
  await app.window
    .getByRole("button", { name: /Existing draft parking thread/i })
    .first()
    .click();
  await expect(
    app.window.getByRole("heading", { level: 2, name: "Existing draft parking thread" }),
  ).toBeVisible();
}

async function pasteIntoReply(
  page: Page,
  params: { html?: string; text: string },
): Promise<void> {
  await page.evaluate(({ html, text }) => {
    const textbox = Array.from(
      document.querySelectorAll<HTMLElement>('[role="textbox"]'),
    ).find((element) => element.getAttribute("aria-label") === "Reply");
    if (!textbox) {
      throw new Error("Reply Tiptap textbox not found");
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", text);
    if (html) {
      dataTransfer.setData("text/html", html);
    }
    textbox.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  }, params);
}

// Prose paragraphs whose only paragraph-break signal lives in text/html. The
// text/plain flavor flattens them to single newlines (as many rich sources do).
const PROSE_LINES = [
  "We reproduced and fixed the upload bug.",
  "Root cause:",
  "After selecting multiple reel items, the click silently fell through.",
  "Fix:",
  "Handle upload by command/title as well as object identity:",
];
const PROSE_PLAIN_SINGLE_NL = PROSE_LINES.join("\n");
const PROSE_HTML = PROSE_LINES.map((line) => `<p>${line}</p>`).join("");

const CODE_LINES = [
  "} else if button === uploadButton {",
  "    uploadButtonClicked()",
  "}",
];
const CODE_PLAIN = ["```swift", ...CODE_LINES, "```"].join("\n");
const CODE_HTML = `<pre><code class="language-swift">${CODE_LINES.join("\n")}</code></pre>`;

// The prose serialized with real paragraph breaks (what the HTML structure means).
const EXPECTED_PROSE_VALUE = PROSE_LINES.join("\n\n");
const EXPECTED_CODE_VALUE = ["```swift", ...CODE_LINES, "```"].join("\n");

test("pasting prose without a code block preserves paragraph separators", async () => {
  const fixture = await createPasteFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    await openExistingThread(app);
    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "Reply" }).focus();

    await pasteIntoReply(app.window, {
      html: PROSE_HTML,
      text: PROSE_PLAIN_SINGLE_NL,
    });

    await expect(tiptapInput).toHaveAttribute("data-value", EXPECTED_PROSE_VALUE);
    await expect(
      tiptapInput.locator(".composer-tiptap-input__editor > p"),
    ).toHaveCount(PROSE_LINES.length);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("a trailing code block does not collapse the paragraph separators above it", async () => {
  const fixture = await createPasteFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    await openExistingThread(app);
    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "Reply" }).focus();

    await pasteIntoReply(app.window, {
      html: `${PROSE_HTML}${CODE_HTML}`,
      text: `${PROSE_PLAIN_SINGLE_NL}\n${CODE_PLAIN}`,
    });

    // The prose paragraphs keep the SAME blank-line separators as the no-code
    // paste above, and the fenced code block is appended after one blank line.
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      `${EXPECTED_PROSE_VALUE}\n\n${EXPECTED_CODE_VALUE}`,
    );
    // Prose stays as distinct paragraphs (the bug collapsed them into one). The
    // doc ends in a code block, so ProseMirror appends a trailing empty
    // paragraph — assert "not collapsed" rather than an exact count.
    expect(
      await tiptapInput.locator(".composer-tiptap-input__editor > p").count(),
    ).toBeGreaterThanOrEqual(PROSE_LINES.length);
    await expect(
      tiptapInput.locator(".composer-tiptap-input__editor > pre"),
    ).toHaveCount(1);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("a pasted code fence still becomes a code block when the clipboard is plain-text only", async () => {
  const fixture = await createPasteFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    await openExistingThread(app);
    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "Reply" }).focus();

    // No text/html: text/plain is the authoritative markdown source, so the
    // custom fence parse must still run and form the code block.
    await pasteIntoReply(app.window, {
      text: ["Intro paragraph.", "", "Body paragraph.", "", CODE_PLAIN].join("\n"),
    });

    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      `Intro paragraph.\n\nBody paragraph.\n\n${EXPECTED_CODE_VALUE}`,
    );
    await expect(
      tiptapInput.locator(".composer-tiptap-input__editor > pre"),
    ).toHaveCount(1);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("a code fence is upgraded from text/plain even when HTML is present but has no code block", async () => {
  const fixture = await createPasteFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    await openExistingThread(app);
    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "Reply" }).focus();

    // HTML is present but carries NO <pre>, so it does not represent the code
    // block the text/plain fence implies. text/plain stays authoritative: the
    // custom fence parse must still run and form the code block. (If the guard
    // deferred on any HTML rather than on a <pre> specifically, the default
    // paste would render the prose <p>s and drop the fence to literal text.)
    await pasteIntoReply(app.window, {
      html: "<p>Intro paragraph.</p><p>Body paragraph.</p>",
      text: ["Intro paragraph.", "", "Body paragraph.", "", CODE_PLAIN].join("\n"),
    });

    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      `Intro paragraph.\n\nBody paragraph.\n\n${EXPECTED_CODE_VALUE}`,
    );
    await expect(
      tiptapInput.locator(".composer-tiptap-input__editor > pre"),
    ).toHaveCount(1);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

// --- Convergence: one source markdown, two clipboard flavors, one paste result ---
//
// A faithful "copy from VS Code" puts the markdown SOURCE on text/plain (real
// blank-line paragraph breaks, literal ``` fences, 1./2. list markers). A "copy
// from the rendered message" puts text/html on the clipboard (<p>/<ol>/<pre>).
// Pasting either must UPGRADE to the same composer document — identical
// serialized markdown and equivalent rendered blocks. This is the contract that
// keeps the two distinct parsers in agreement: the plain-text path runs through
// buildMarkdownTiptapContent (blank-line splits + section-label heuristic + list/
// fence parsing) while the HTML path runs through ProseMirror's DOM parser, and
// both feed the same markdown serializer. A divergence here is invisible to the
// per-flavor tests above; only pasting both flavors of one source catches it.
const SOURCE_PARAGRAPHS = [
  "We reproduced and fixed the upload bug.",
  "Root cause:",
  "After selecting multiple reel items, the click silently fell through.",
  "Fix:",
  "Handle upload by command/title as well as object identity:",
];
const SOURCE_LIST = [
  "Create several ready recordings.",
  "Add them to the GGDataStore.",
];
const SOURCE_CODE = [
  "} else if button === uploadButton {",
  "    uploadButtonClicked()",
  "}",
];

// text/plain flavor — faithful markdown, paragraph breaks as real blank lines.
const SOURCE_PLAIN = [
  SOURCE_PARAGRAPHS[0],
  "",
  SOURCE_PARAGRAPHS[1],
  "",
  SOURCE_PARAGRAPHS[2],
  "",
  SOURCE_PARAGRAPHS[3],
  "",
  SOURCE_PARAGRAPHS[4],
  "",
  `1. ${SOURCE_LIST[0]}`,
  `2. ${SOURCE_LIST[1]}`,
  "",
  "```swift",
  ...SOURCE_CODE,
  "```",
].join("\n");

// text/html flavor — the rendered representation of the same source. Joined with
// no inter-tag whitespace so the DOM parser sees only the block structure.
const SOURCE_HTML = [
  ...SOURCE_PARAGRAPHS.map((line) => `<p>${line}</p>`),
  `<ol><li>${SOURCE_LIST[0]}</li><li>${SOURCE_LIST[1]}</li></ol>`,
  `<pre><code class="language-swift">${SOURCE_CODE.join("\n")}</code></pre>`,
].join("");

// The canonical markdown both paste paths must serialize to.
const SOURCE_EXPECTED = [
  SOURCE_PARAGRAPHS.join("\n\n"),
  `1. ${SOURCE_LIST[0]}\n2. ${SOURCE_LIST[1]}`,
  ["```swift", ...SOURCE_CODE, "```"].join("\n"),
].join("\n\n");

async function pasteSourceAndReadResult(flavor: {
  html?: string;
  text: string;
}): Promise<{ liCount: number; pCount: number; preCount: number; value: string | null }> {
  const fixture = await createPasteFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });
  try {
    await openExistingThread(app);
    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "Reply" }).focus();
    await pasteIntoReply(app.window, flavor);

    const editor = tiptapInput.locator(".composer-tiptap-input__editor");
    // The code block only renders once the paste has fully settled; wait on it
    // before reading data-value so the snapshot is post-paste for both flavors.
    await expect(editor.locator("> pre")).toHaveCount(1);
    return {
      value: await tiptapInput.getAttribute("data-value"),
      liCount: await editor.locator("> ol > li").count(),
      pCount: await editor.locator("> p").count(),
      preCount: await editor.locator("> pre").count(),
    };
  } finally {
    await app.close();
    await fixture.cleanup();
  }
}

test("plain-text and text/html copies of one source paste to identical markdown", async () => {
  // VS Code-style copy: text/plain is the only (authoritative) source, so the
  // fence parser upgrades it to paragraphs + ordered list + code block.
  const plain = await pasteSourceAndReadResult({ text: SOURCE_PLAIN });
  // Rendered-message copy: text/html drives structure and its <pre> makes the
  // paste HTML-authoritative, so the prose paragraphs above it are not collapsed.
  const html = await pasteSourceAndReadResult({ html: SOURCE_HTML, text: SOURCE_PLAIN });

  // Both flavors upgraded to the same blocks...
  for (const result of [plain, html]) {
    expect(result.liCount).toBe(SOURCE_LIST.length);
    expect(result.preCount).toBe(1);
    expect(result.pCount).toBeGreaterThanOrEqual(SOURCE_PARAGRAPHS.length);
  }
  // ...and, crucially, serialized to byte-identical markdown — and to the
  // canonical round-trip form, not merely to each other.
  expect(html.value).toBe(plain.value);
  expect(plain.value).toBe(SOURCE_EXPECTED);
});
