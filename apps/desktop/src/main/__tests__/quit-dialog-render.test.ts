import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true },
}));
vi.mock("../ipc/integrated-terminal", () => ({
  revealIntegratedTerminal: vi.fn(),
}));
vi.mock("../window-show-thread", () => ({ requestShowThread: vi.fn() }));
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
} from "../quit-confirmation-dialog";

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
    }
  });
});
