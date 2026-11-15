// The quit dialog's footer runs a small script inside its own window: it
// shows Quiet & Continue After Restart only while thread work runs, makes
// that the default action while it shows, and keeps focus off any control it
// hides. The script is the system under test, so this file executes it in
// jsdom against the page the main process builds, then drives it the way the
// main process does: by handing it refresh payloads.
//
// The model is two lines: Quiet is offered exactly when a handler is wired
// and thread work is running in the latest snapshot, and Enter on no control
// runs Quiet while it is offered, else Quit Now.
import { createRequire } from "node:module";
import fc from "fast-check";
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
  QUIT_DIALOG_PALETTES,
  buildQuitConfirmationHtml,
  buildQuitDialogUpdatePayload,
  type QuitBlockerItem,
} from "../shell/quit-confirmation-dialog";

type DialogWindow = Window & typeof globalThis & {
  __pwragentUpdateQuitSnapshot?: (payload: unknown) => void;
};
type DialogDom = { window: DialogWindow };
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options: { runScripts: "dangerously"; virtualConsole: unknown },
  ) => DialogDom;
  VirtualConsole: new () => unknown;
};

const PREFIX = "pwragent-quit-confirmation://tok/";

type Counts = { threads: number; terminals: number; actions: number };

function itemsFor(counts: Counts): QuitBlockerItem[] {
  const items: QuitBlockerItem[] = [];
  for (let index = 0; index < counts.threads; index += 1) {
    items.push({ kind: "turn", backend: "codex", threadId: `t${index}`, threadKey: `codex:t${index}`, title: `Thread ${index}` });
  }
  for (let index = 0; index < counts.terminals; index += 1) {
    items.push({ kind: "terminal", backend: "codex", threadId: `s${index}`, threadKey: `codex:s${index}`, title: `Shell ${index}` });
  }
  for (let index = 0; index < counts.actions; index += 1) {
    items.push({ kind: "action", backend: "codex", threadId: `a${index}`, threadKey: `codex:a${index}`, title: `Action ${index}` });
  }
  return items;
}

/** Open the page as the dialog window does, with its autofocus applied. */
function openDialog(counts: Counts, wired: boolean) {
  const html = buildQuitConfirmationHtml({
    countdownSeconds: 30,
    inProgressThreadCount: counts.threads,
    terminalSessionCount: counts.terminals,
    actionRunCount: counts.actions,
    items: itemsFor(counts),
    ...(wired ? { quietRestartAvailable: true } : {}),
    navigationPrefix: PREFIX,
    colorScheme: "dark",
    palette: QUIT_DIALOG_PALETTES.dark,
  });
  // The page reports actions by navigating, which jsdom does not implement.
  // A silent console keeps that out of the run; clicks are what we observe.
  const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
  const { document } = dom.window;
  const autofocused = document.querySelectorAll<HTMLElement>("[autofocus]");
  autofocused[0]?.focus();
  const clicks: string[] = [];
  for (const button of document.querySelectorAll("button")) {
    button.addEventListener("click", () => clicks.push(button.id));
  }
  return {
    dom,
    document,
    autofocused: [...autofocused].map((element) => element.id),
    clicks,
    refresh(next: Counts) {
      dom.window.__pwragentUpdateQuitSnapshot?.(buildQuitDialogUpdatePayload(
        {
          inProgressThreadCount: next.threads,
          automationRunCount: 0,
          terminalSessionCount: next.terminals,
          actionRunCount: next.actions,
          items: itemsFor(next),
        },
        PREFIX,
        wired,
      ));
    },
    key(key: string) {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
    shown(id: string): boolean {
      const element = document.getElementById(id);
      return Boolean(element) && !element!.hidden;
    },
    close() {
      dom.window.close();
    },
  };
}

const countsArb = fc.record({
  threads: fc.integer({ min: 0, max: 3 }),
  terminals: fc.integer({ min: 0, max: 2 }),
  actions: fc.integer({ min: 0, max: 1 }),
});
const stepArb = fc.oneof(
  countsArb.map((counts) => ({ kind: "refresh" as const, counts })),
  fc.constantFrom("stay", "quit", "quiet-restart", "quiet-help-toggle", "body")
    .map((target) => ({ kind: "focus" as const, target })),
  fc.constant({ kind: "toggle-help" as const }),
);

describe("quit dialog default action", () => {
  it("offers Quiet only while thread work runs, and Enter follows the offer", () => {
    fc.assert(
      fc.property(fc.boolean(), countsArb, fc.array(stepArb, { maxLength: 8 }), (wired, initial, steps) => {
        const dialog = openDialog(initial, wired);
        try {
          const offered = (counts: Counts) => wired && counts.threads > 0;
          let current = initial;
          // The page opens with focus on the default action.
          expect(dialog.autofocused).toEqual([offered(initial) ? "quiet-restart" : "quit"]);
          for (const step of steps) {
            if (step.kind === "refresh") {
              current = step.counts;
              dialog.refresh(current);
            } else if (step.kind === "focus") {
              const target = step.target === "body"
                ? undefined
                : dialog.document.getElementById(step.target);
              if (step.target === "body") (dialog.document.activeElement as HTMLElement | null)?.blur();
              else if (target && !target.hidden) target.focus();
            } else if (dialog.shown("quiet-help-toggle")) {
              dialog.document.getElementById("quiet-help-toggle")!.click();
            }

            expect(dialog.shown("quiet-restart")).toBe(offered(current));
            expect(dialog.shown("quiet-help-toggle")).toBe(offered(current));
            if (!offered(current)) expect(dialog.shown("quiet-help")).toBe(false);
            // Focus never rests on a control the page has hidden.
            expect((dialog.document.activeElement as HTMLElement | null)?.hidden ?? false).toBe(false);
          }

          // Enter on no particular control runs the default action.
          (dialog.document.activeElement as HTMLElement | null)?.blur();
          dialog.clicks.length = 0;
          dialog.key("Enter");
          expect(dialog.clicks).toEqual([offered(current) ? "quiet-restart" : "quit"]);
        } finally {
          dialog.close();
        }
      }),
      { numRuns: 80 },
    );
  });

  // The case that shipped wrong: the threads finished, a terminal kept the
  // dialog up, and Quiet stayed offered with nothing left to continue.
  it("withdraws Quiet when thread work ends and moves focus to Quit Now", () => {
    const dialog = openDialog({ threads: 1, terminals: 1, actions: 0 }, true);
    try {
      expect(dialog.document.activeElement?.id).toBe("quiet-restart");
      dialog.refresh({ threads: 0, terminals: 1, actions: 0 });
      expect(dialog.shown("quiet-restart")).toBe(false);
      expect(dialog.document.activeElement?.id).toBe("quit");
    } finally {
      dialog.close();
    }
  });

  it("lets a focused button answer Enter itself", () => {
    const dialog = openDialog({ threads: 1, terminals: 0, actions: 0 }, true);
    try {
      dialog.document.getElementById("stay")!.focus();
      dialog.key("Enter");
      // The browser's own activation clicks Stay Open; the page adds nothing.
      expect(dialog.clicks).toEqual([]);
    } finally {
      dialog.close();
    }
  });

  it("opens the explainer from ?, and Esc closes it before it closes the dialog", () => {
    const dialog = openDialog({ threads: 2, terminals: 0, actions: 0 }, true);
    try {
      const toggle = dialog.document.getElementById("quiet-help-toggle")!;
      toggle.focus();
      toggle.click();
      expect(dialog.shown("quiet-help")).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      dialog.key("Escape");
      expect(dialog.shown("quiet-help")).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(dialog.document.activeElement).toBe(toggle);
    } finally {
      dialog.close();
    }
  });
});
