import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppMenuBar } from "../AppMenuBar";

const model = [
  { index: 0, label: "File" },
  { index: 1, label: "Edit" },
  { index: 2, label: "View" },
];

const popupAppMenu = vi.fn();

beforeEach(() => {
  popupAppMenu.mockClear();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: {
      platform: "linux",
      getAppMenuModel: () => Promise.resolve(model),
      popupAppMenu,
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: undefined,
  });
});

/**
 * Wait for the bar to be listening, not merely painted.
 *
 * `findByRole` is the wrong signal here. It resolves off the commit's own
 * MutationObserver record — a microtask — while React schedules that commit's
 * passive effects with `setImmediate`, and Testing Library's async wrapper ends
 * on a `setTimeout(…, 0)` in the earlier timers phase. So the buttons can be on
 * screen with the `useEffect` that adds the window-level Alt listeners still
 * queued, and every key this file dispatches then lands on nothing. The trace
 * from a failing run reads: dispatch:keydown, dispatch:keyup, add:keydown,
 * add:keyup — the bar never opens, and the assertion a second later reports a
 * DOM that never changed. It cost PR #2114 a red `Test` and `Windows renderer +
 * packages` on a file that branch did not contain.
 *
 * `act` enqueues with `setImmediate` too, so an awaited scope queues strictly
 * behind React's pending flush and drains it. It also settles the menu model's
 * promise inside the scope, so the render that promise causes is flushed here
 * rather than whenever the scheduler gets to it.
 */
async function settleMenuBar(): Promise<void> {
  // Same body as the `flushReactUpdates` helpers in `app-shell.test.tsx`,
  // `composer.test.tsx`, and `useThreadSessionState.test.tsx` — worth
  // consolidating one day. The macrotask hop inside the scope is what keeps
  // this honest if `getAppMenuModel` ever resolves over more than one tick.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // Not a stray query: `getByRole` throws when the model never landed, so this
  // is the assertion that the bar is on screen before any key is dispatched.
  screen.getByRole("menuitem", { name: "File" });
}

/** The bar plus a composer to steal focus from, the way the strip sits above one. */
async function mountWithComposer(): Promise<HTMLTextAreaElement> {
  render(
    <>
      <AppMenuBar />
      <textarea aria-label="Reply" />
    </>,
  );
  await settleMenuBar();
  const composer = screen.getByRole("textbox", {
    name: "Reply",
  }) as HTMLTextAreaElement;
  composer.focus();
  expect(composer).toHaveFocus();
  return composer;
}

/**
 * Dispatch ONE keyboard event and let React settle before the next.
 *
 * Each act() is its own flush, which is the whole point: a browser delivers
 * these as separate tasks, so a state update from the Alt key-down has already
 * moved DOM focus by the time the next key-down arrives. Batching a whole
 * chord into one act() hides exactly the bug these tests exist for — focus
 * never moves mid-chord, so the pre-fix component passes.
 */
function fire(type: "keydown" | "keyup", init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
  });
}

/** One key, pressed and released on its own. */
function tap(key: string): void {
  fire("keydown", { key });
  fire("keyup", { key });
}

/** Alt held down, another key tapped inside it, then Alt released. */
function chord(key: string): void {
  fire("keydown", { key: "Alt" });
  fire("keydown", { key, altKey: true });
  fire("keyup", { key, altKey: true });
  fire("keyup", { key: "Alt" });
}

describe("Alt and the painted menu bar", () => {
  it("enters the bar on a plain Alt and leaves on the next one", async () => {
    // Firefox's behavior on Linux, which is the bar operators here compare
    // against: Alt takes focus to the menu, Alt again gives it back to the
    // page — caret where it was, no Escape needed.
    const composer = await mountWithComposer();

    tap("Alt");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "File" })).toHaveFocus(),
    );

    tap("Alt");
    await waitFor(() => expect(composer).toHaveFocus());
    expect(screen.getByRole("menuitem", { name: "File" })).not.toHaveClass(
      "is-focused",
    );
  });

  it("leaves on Escape too, with the caret back in the composer", async () => {
    const composer = await mountWithComposer();

    tap("Alt");
    const file = await screen.findByRole("menuitem", { name: "File" });
    await waitFor(() => expect(file).toHaveFocus());

    act(() => {
      file.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("keeps Alt+Enter in the composer", async () => {
    // The regression the Linux E2E lane caught. Activating on key DOWN moved
    // focus to File the instant Alt went down, so the Enter of Alt+Enter
    // landed on a menu button instead of inserting a hard break in the
    // composer's list item.
    const composer = await mountWithComposer();

    chord("Enter");

    expect(composer).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "File" })).not.toHaveClass(
      "is-focused",
    );
  });

  it.each(["ArrowUp", "Tab", "a", "F4"])(
    "keeps Alt+%s out of the bar",
    async (key) => {
      // Any other key during the hold disqualifies the release. Only the
      // mnemonic branch may act on a chord, and it opens a menu rather than
      // parking focus on one.
      const composer = await mountWithComposer();

      chord(key);

      if (key === "a") {
        // No entry starts with "a" in this model, so nothing opens either.
        expect(popupAppMenu).not.toHaveBeenCalled();
      }
      expect(composer).toHaveFocus();
    },
  );

  it("still opens a menu by mnemonic", async () => {
    const composer = await mountWithComposer();

    chord("e");

    expect(popupAppMenu).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1 }),
    );
    // The native submenu owns the keyboard now; the bar should not also be
    // sitting on focus when it closes.
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("restores nothing when the bar was entered by mouse", async () => {
    // A click already moved focus on purpose. Remembering the composer here
    // would send the caret back on the next Alt from somewhere unrelated.
    await mountWithComposer();
    const file = await screen.findByRole("menuitem", { name: "File" });

    act(() => file.click());

    expect(popupAppMenu).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0 }),
    );
  });

  it("survives the composer unmounting while the bar holds focus", async () => {
    // A thread switch can drop the surface that had focus. Focusing a detached
    // node silently does nothing, so the guard is what keeps this from
    // stranding focus on <body> with no error.
    const { unmount } = render(<textarea aria-label="Scratch" />);
    render(<AppMenuBar />);
    await settleMenuBar();
    const scratch = screen.getByRole("textbox", { name: "Scratch" });
    scratch.focus();

    tap("Alt");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "File" })).toHaveFocus(),
    );
    unmount();

    expect(() => tap("Alt")).not.toThrow();
  });
});
