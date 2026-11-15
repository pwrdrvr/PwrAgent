import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true },
}));
vi.mock("../shell/ipc/integrated-terminal", () => ({
  revealIntegratedTerminal: vi.fn(),
}));
vi.mock("../shell/window-show-thread", () => ({ requestShowThread: vi.fn() }));
vi.mock("../settings/appearance-bootstrap", () => ({
  readBootstrapAppearance: () => ({ theme: "dark" }),
}));

import {
  COLOR_THEME_QUIT_DIALOG_PALETTES,
  QUIT_DIALOG_PALETTES,
  buildQuitConfirmationHtml,
  estimateQuitDialogHeight,
  quitDialogHeightCap,
  type QuitBlockerItem,
} from "../shell/quit-confirmation-dialog";

const items: QuitBlockerItem[] = [
  {
    kind: "turn",
    backend: "codex",
    threadId: "t1",
    threadKey: "codex:t1",
    title: "Migrate Next Chunk - Same Tree",
  },
  ...Array.from({ length: 10 }, (_, index) => ({
    kind: "terminal" as const,
    backend: "codex",
    threadId: `term-${index}`,
    threadKey: `codex:term-${index}`,
    title: `Terminal thread ${index + 1}`,
  })),
  {
    kind: "action",
    backend: "codex",
    threadId: "a1",
    threadKey: "codex:a1",
    title: "channelsv2 live pods APM",
    detail: "pnpm op:dev · pid 2949",
  },
];

describe("quit dialog HTML", () => {
  it("names pending cleanup work and explains restart recovery", () => {
    const html = buildQuitConfirmationHtml({ countdownSeconds: 10, inProgressThreadCount: 0,
      terminalSessionCount: 0, actionRunCount: 0, archiveCleanupCount: 130, items: [],
      navigationPrefix: "pwragent-quit-confirmation://tok/", colorScheme: "dark", palette: QUIT_DIALOG_PALETTES.dark });
    expect(html).toContain("130 worktree cleanups are pending.");
    expect(html).toContain("unfinished worktree cleanups will be saved and resumed at the next start");
    expect(html).not.toContain("PwrAgent is ready to quit.");
  });
  it("renders each blocker as a link and keeps the list scrollable", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 1,
      terminalSessionCount: 10,
      actionRunCount: 1,
      items,
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: QUIT_DIALOG_PALETTES.dark,
    });

    // Every running item is reachable, and the counts read as one sentence.
    expect(html).toContain(
      "1 thread has work in progress, 10 integrated terminals are running, and 1 environment action is running.",
    );
    expect(html).toContain("Select an item below to go to it instead.");
    expect(html).toContain("Thread work in progress");
    expect(html).toContain("Integrated terminals");
    expect(html).toContain("Environment actions");
    expect(html).not.toContain(">Sub-agent</span>");
    expect(html).toContain(
      'href="pwragent-quit-confirmation://tok/show-thread/codex%3Aterm-0/terminal"',
    );
    expect(html).toContain("pnpm op:dev · pid 2949");

    // Ten rows must not blow the dialog open — the list scrolls inside it.
    expect(html).toContain("overflow-y: auto");
    // Group headings carry their row counts.
    expect(html).toContain('<span>Integrated terminals</span><span class="group__count">10</span>');
  });

  // The page used to grow past its fixed-size window, and the autofocused
  // Quit button then scrolled the document: the title strip slid off the top.
  it("pins the title strip and buttons and scrolls only the middle", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 1,
      terminalSessionCount: 10,
      actionRunCount: 1,
      items,
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: QUIT_DIALOG_PALETTES.dark,
    });
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    /** The declarations of the first rule written exactly as `selector {`. */
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n      ${selector} {`);
      return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
    };

    expect(rule("body")).toMatch(/height: 100%;/);
    expect(rule("body")).toMatch(/overflow: hidden;/);
    expect(rule("body")).not.toMatch(/min-height/);
    expect(rule(".scroll")).toMatch(/overflow-y: auto;/);
    expect(rule(".scroll > .list")).toMatch(/overflow-y: auto;/);
    expect(rule(".footer")).toMatch(/flex: 0 0 auto;/);

    // The list sits in the scrolling region; the buttons sit outside it.
    const body = html.slice(html.indexOf("<body>"));
    const scrollStart = body.indexOf('<div class="scroll" id="scroll">');
    const footerStart = body.indexOf('<footer class="footer">');
    expect(scrollStart).toBeGreaterThan(body.indexOf('<header class="titlebar">'));
    expect(body.indexOf('<div class="list" id="list">')).toBeGreaterThan(scrollStart);
    expect(body.indexOf('<div class="list" id="list">')).toBeLessThan(footerStart);
    expect(body.indexOf('id="quit"')).toBeGreaterThan(footerStart);
  });

  it("sizes the window to its content, between a floor and a ceiling", () => {
    const counts = { inProgressThreadCount: 2, terminalSessionCount: 0, actionRunCount: 0 };
    const turns = items.slice(0, 1);
    const one = estimateQuitDialogHeight({ ...counts, items: turns });
    const three = estimateQuitDialogHeight({ ...counts, items: [...turns, ...items.slice(1, 3)] });
    // A second group heading and two rows.
    expect(three - one).toBe(30 + 30 * 2);
    // The peer notice is a paragraph of its own.
    expect(estimateQuitDialogHeight({ ...counts, federationPeerCount: 2, items: turns }))
      .toBeGreaterThan(one + 40);
    // Never taller than the ceiling; the list scrolls past it.
    expect(estimateQuitDialogHeight({ ...counts, terminalSessionCount: 10, actionRunCount: 1, items })).toBe(620);
    // Never so short that the buttons crowd the heading.
    expect(estimateQuitDialogHeight({ inProgressThreadCount: 0, terminalSessionCount: 0, actionRunCount: 0, items: [] }))
      .toBe(360);
  });

  it("never opens taller than a small work area", () => {
    expect(quitDialogHeightCap(900)).toBe(852);
    // The floor holds while the area can fit it with its margins...
    expect(quitDialogHeightCap(390)).toBe(360);
    // ...and gives way to the area itself below that, so the top stays on screen.
    expect(quitDialogHeightCap(340)).toBe(340);
  });

  it("names the owning peer on a remote terminal row", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
      actionRunCount: 0,
      items: [
        {
          kind: "terminal",
          backend: "codex",
          threadId: "0f9c2b7a-remote",
          threadKey: "codex:0f9c2b7a-remote",
          title: "Reap Windows Worktrees",
          target: { scope: "remote", instanceId: "peer-a" },
          detail: "Studio Mac",
        },
      ],
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: QUIT_DIALOG_PALETTES.dark,
    });

    // The name the viewer already shows for this thread, plus the machine the
    // shell is actually running on.
    expect(html).toContain("Reap Windows Worktrees");
    expect(html).toContain("Studio Mac");
    expect(html).not.toContain(">0f9c2b7a-remote<");
  });

  it("names the owning thread and labels a sub-agent blocker", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 1,
      terminalSessionCount: 0,
      actionRunCount: 0,
      items: [
        {
          kind: "turn",
          backend: "codex",
          threadId: "parent-thread",
          threadKey: "codex:parent-thread",
          title: "Deploy recoverable M2 Max runner",
          isSubAgent: true,
        },
      ],
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: QUIT_DIALOG_PALETTES.dark,
    });

    expect(html).toContain("Deploy recoverable M2 Max runner");
    expect(html).toContain(">Sub-agent</span>");
    expect(html).toContain(
      'href="pwragent-quit-confirmation://tok/show-thread/codex%3Aparent-thread/turn"',
    );
  });

  it("escapes the action detail, which carries a user-configured command", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 0,
      actionRunCount: 1,
      items: [
        {
          kind: "action",
          backend: "codex",
          threadId: "t1",
          threadKey: "codex:t1",
          title: "Dev server",
          detail: '</span><script>alert(1)</script> · pid 1',
        },
      ],
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: QUIT_DIALOG_PALETTES.dark,
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("forbids the network so an escaping slip cannot exfiltrate", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
      actionRunCount: 0,
      items,
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: QUIT_DIALOG_PALETTES.dark,
    });

    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
  });

  it("escapes thread titles rather than injecting them as markup", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
      actionRunCount: 0,
      items: [
        {
          kind: "terminal",
          backend: "codex",
          threadId: "t1",
          threadKey: "codex:t1",
          title: '<img src=x onerror="alert(1)">',
        },
      ],
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: QUIT_DIALOG_PALETTES.dark,
    });

    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("quit dialog Quiet & Continue After Restart", () => {
  const base = {
    countdownSeconds: 10,
    terminalSessionCount: 0,
    actionRunCount: 0,
    items: items.slice(0, 3),
    navigationPrefix: "pwragent-quit-confirmation://tok/",
    colorScheme: "dark" as const,
    palette: QUIT_DIALOG_PALETTES.dark,
  };

  /** The opening tag of the element with this id. */
  const tag = (html: string, id: string): string => {
    const at = html.indexOf(`id="${id}"`);
    return at < 0 ? "" : html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  };

  it("offers it as the default while thread work runs and a handler is wired", () => {
    const html = buildQuitConfirmationHtml({ ...base, inProgressThreadCount: 1, quietRestartAvailable: true });
    expect(html).toContain("Quiet &amp; Continue After Restart");
    // The filled default, focused on open; Quit Now is the danger choice.
    expect(tag(html, "quiet-restart")).toContain('class="primary"');
    expect(tag(html, "quiet-restart")).toContain("autofocus");
    expect(tag(html, "quiet-restart")).not.toContain("hidden");
    expect(tag(html, "quit")).toContain('class="danger"');
    expect(tag(html, "quit")).not.toContain("autofocus");
    // In the pinned footer's quit group, after Quit Now; Wait for Work first.
    // The close button and Esc keep PwrAgent open, so there is no Stay Open.
    const body = html.slice(html.indexOf("<body>"));
    expect(body.indexOf('id="wait"')).toBeLessThan(body.indexOf('class="actions__group actions__group--quit"'));
    expect(body).not.toContain('id="stay"');
    expect(body).not.toContain(">Stay Open<");
    // Every row is right-aligned; nothing pins a button to the left edge.
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(css).toMatch(/\n {6}\.actions \{[^}]*justify-content: flex-end;/);
    expect(css).not.toMatch(/margin-left: auto/);
    expect(body.indexOf('id="quiet-restart"')).toBeGreaterThan(body.indexOf('id="quit"'));
    expect(body.indexOf('id="quiet-restart"')).toBeLessThan(body.indexOf("</footer>"));
  });

  it("explains itself through a disclosure, not a tooltip", () => {
    const html = buildQuitConfirmationHtml({ ...base, inProgressThreadCount: 1, quietRestartAvailable: true });
    const toggle = tag(html, "quiet-help-toggle");
    expect(toggle).toContain('aria-label="About Quiet &amp; Continue After Restart"');
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('aria-controls="quiet-help"');
    // Screen readers hear the explanation on the button itself.
    expect(tag(html, "quiet-restart")).toContain('aria-describedby="quiet-help"');
    expect(tag(html, "quiet-restart")).not.toContain("title=");
    // Closed until asked, and it says what stops, what resumes, and what does not.
    expect(tag(html, "quiet-help")).toContain("hidden");
    const help = html.slice(html.indexOf('id="quiet-help"'), html.indexOf("</footer>"));
    expect(help).toContain("gets up to 15 seconds to finish its step");
    expect(help).toContain("Environment actions are stopped. Queued messages are kept.");
    expect(help).toContain("continues where it left off, a few at a time");
    expect(help).toContain("Integrated terminals still end when PwrAgent quits.");
  });

  it("is hidden with no thread work and absent with no handler", () => {
    const idle = buildQuitConfirmationHtml({ ...base, inProgressThreadCount: 0, quietRestartAvailable: true });
    // Rendered so a refresh can offer it, but hidden, with Quit Now the default.
    expect(tag(idle, "quiet-restart")).toContain("hidden");
    expect(tag(idle, "quiet-restart")).not.toContain("autofocus");
    expect(tag(idle, "quiet-help-toggle")).toContain("hidden");
    expect(tag(idle, "quit")).toContain("autofocus");
    const unwired = buildQuitConfirmationHtml({ ...base, inProgressThreadCount: 1 });
    expect(unwired).not.toContain('id="quiet-restart"');
    expect(unwired).not.toContain('id="quiet-help-toggle"');
    expect(tag(unwired, "quit")).toContain("autofocus");
  });

  it("makes room for its row", () => {
    const counts = { inProgressThreadCount: 2, terminalSessionCount: 0, actionRunCount: 0, items: items.slice(0, 3) };
    expect(estimateQuitDialogHeight({ ...counts, quietRestartAvailable: true })
      - estimateQuitDialogHeight(counts)).toBe(42);
  });
});

describe("quit dialog color theme palettes", () => {
  it("matches every color theme to its app.css block", () => {
    // The dialog is a `data:` window with no app.css, so these literals are
    // copies. Hold them to the source.
    const css = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../renderer/src/styles/app.css",
      ),
      "utf8",
    );
    const fields = {
      bg: "bg-app",
      sidebar: "bg-sidebar",
      surface: "bg-panel-elevated",
      rowActive: "bg-row-active",
      panelHover: "bg-panel-hover",
      textPrimary: "text-primary",
      textSecondary: "text-secondary",
      textMuted: "text-muted",
      accent: "accent",
      accentBright: "accent-bright",
      buttonText: "button-text",
    } as const;
    for (const [theme, palette] of Object.entries(COLOR_THEME_QUIT_DIALOG_PALETTES)) {
      const block = css.match(
        new RegExp(`:root\\[data-color-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`),
      )?.[1];
      expect(block, theme).toBeDefined();
      for (const [field, token] of Object.entries(fields)) {
        expect(block, `${theme}: ${field}`).toContain(
          `--${token}: ${palette[field as keyof typeof fields]};`,
        );
      }
      // A theme that fills with a color of its own lists it; the rest
      // inherit :root's --accent-fill, the accent.
      if (palette.accentFill) {
        expect(block, `${theme}: accentFill`).toContain(
          `--accent-fill: ${palette.accentFill};`,
        );
      } else {
        expect(block, `${theme}: accentFill`).not.toContain("--accent-fill:");
      }
      // Quit Now's danger treatment. These themes derive soft and border
      // from the base, and the dialog derives them the same way.
      expect(block, `${theme}: danger`).toContain(`--danger-base: ${palette.danger};`);
      expect(block, `${theme}: dangerText`).toContain(`--danger-text: ${palette.dangerText};`);
      expect(block, `${theme}: dangerSoft`).toContain(
        "--danger-soft: color-mix(in srgb, var(--danger-base) 24%, transparent);",
      );
      expect(block, `${theme}: dangerBorder`).toContain(
        "--danger-border: color-mix(in srgb, var(--danger-base) 45%, transparent);",
      );
      expect(palette.dangerSoft, theme).toBeUndefined();
      expect(palette.dangerBorder, theme).toBeUndefined();
    }
  });

  it("matches Tangerine's danger tokens to app.css", () => {
    const css = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../renderer/src/styles/app.css",
      ),
      "utf8",
    );
    const blocks = {
      dark: css.match(/\n:root \{([\s\S]*?)\n\}/)?.[1],
      light: css.match(/\n:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1],
    };
    for (const [scheme, palette] of Object.entries(QUIT_DIALOG_PALETTES)) {
      const block = blocks[scheme as keyof typeof blocks];
      expect(block, scheme).toBeDefined();
      expect(block, scheme).toContain(`--danger-base: ${palette.danger};`);
      expect(block, scheme).toContain(`--danger-text: ${palette.dangerText};`);
      expect(block, scheme).toContain(`--danger-soft: ${palette.dangerSoft};`);
      expect(block, scheme).toContain(`--danger-border: ${palette.dangerBorder};`);
    }
  });

  it("gives Quit Now the danger treatment in the page", () => {
    const html = buildQuitConfirmationHtml({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
      actionRunCount: 0,
      items: [],
      navigationPrefix: "pwragent-quit-confirmation://tok/",
      colorScheme: "dark",
      palette: COLOR_THEME_QUIT_DIALOG_PALETTES["catppuccin-mocha"],
    });
    expect(html).toContain("--danger: #f38ba8;");
    expect(html).toContain("--danger-soft: color-mix(in srgb, var(--danger) 24%, transparent);");
    expect(html).toMatch(/\.danger \{\s*border-color: var\(--danger-border\);\s*background: var\(--danger-soft\);\s*color: var\(--danger-text\);/);
  });
});
