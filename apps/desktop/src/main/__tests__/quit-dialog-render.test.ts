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
  QUIT_DIALOG_PALETTES,
  buildQuitConfirmationHtml,
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
      "1 thread has an agent turn in progress, 10 integrated terminals are running, and 1 environment action is running.",
    );
    expect(html).toContain("Select an item below to go to it instead.");
    expect(html).toContain("Agent turns in progress");
    expect(html).toContain("Integrated terminals");
    expect(html).toContain("Environment actions");
    expect(html).toContain(
      'href="pwragent-quit-confirmation://tok/show-thread/codex%3Aterm-0/terminal"',
    );
    expect(html).toContain("pnpm op:dev · pid 2949");

    // Ten rows must not blow the dialog open — the list scrolls inside it.
    expect(html).toContain("overflow-y: auto");
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
