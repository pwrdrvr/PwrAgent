// Model test of the Dock-click window restore
// (`shell/window-activation-restore.ts`).
//
// The model is a window stack and an AppKit stand-in that, on a Dock click
// that reactivates the app, makes the most recently opened on-screen window
// key. That is the reported behavior: an older window was on top, the
// operator switched apps, and the Dock click brought back the newest one.
// Event order follows a measured real Dock press: `activate` fires before
// `did-become-active`.
//
// The rules, checked after every Dock click:
//
//   R1  A Dock click that reactivates the app brings back the window that
//       was on top when the app resigned active, if it is still open and
//       on screen.
//   R2  A window minimized before switching away comes back only when no
//       other window is on screen; otherwise AppKit's pick stands.
//   R3  A Dock click while the app is already active changes nothing.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createActivationWindowRestorer,
  selectWindowToRestoreOnActivate,
} from "../shell/window-activation-restore";

class ModelWindow {
  closed = false;
  minimized = false;
  constructor(readonly id: number, private readonly model: WindowModel) {}
  focus(): void {
    this.model.raise(this);
  }
  restore(): void {
    if (!this.minimized) return;
    this.minimized = false;
    this.model.raise(this);
  }
  isDestroyed(): boolean {
    return this.closed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isModal(): boolean {
    return false;
  }
  getChildWindows(): never[] {
    return [];
  }
}

class WindowModel {
  windows: ModelWindow[] = [];
  /** On-screen, unminimized windows, front first. */
  stack: ModelWindow[] = [];
  focused: ModelWindow | null = null;
  lastFocused: ModelWindow | undefined;
  active = true;
  readonly restorer = createActivationWindowRestorer<ModelWindow>({
    getWindows: () => this.windows.filter((window) => !window.closed),
    getFocusedWindow: () => this.focused,
    isShown: (window) => !window.closed,
  });

  raise(window: ModelWindow): void {
    this.stack = [window, ...this.stack.filter((other) => other !== window)];
    if (this.active) {
      this.focused = window;
      this.lastFocused = window;
    }
  }

  open(): void {
    const window = new ModelWindow(this.windows.length, this);
    this.windows.push(window);
    this.raise(window);
  }

  focusWindow(index: number): void {
    const window = this.pick(index, (candidate) => !candidate.minimized);
    if (window) this.raise(window);
  }

  minimize(index: number): void {
    const window = this.pick(index, (candidate) => !candidate.minimized);
    if (!window) return;
    window.minimized = true;
    this.stack = this.stack.filter((other) => other !== window);
    // AppKit makes the next window key; with none left, the minimized
    // window stays the last one focused.
    this.focused = this.stack[0] ?? null;
    if (this.focused) this.lastFocused = this.focused;
  }

  close(index: number): void {
    const window = this.pick(index, () => true);
    if (!window) return;
    window.closed = true;
    this.stack = this.stack.filter((other) => other !== window);
    if (this.focused === window) this.focused = this.active ? this.stack[0] ?? null : null;
    if (this.lastFocused === window) this.lastFocused = undefined;
    this.restorer.forget(window);
  }

  switchAway(): void {
    if (!this.active) return;
    this.restorer.resignActive(this.lastFocused);
    this.active = false;
    this.focused = null;
  }

  dockClick(): void {
    if (this.active) {
      this.restorer.activate();
      return;
    }
    // AppKit's pick: the newest on-screen window becomes key and front.
    const newest = [...this.windows].reverse().find((window) => this.stack.includes(window));
    if (newest) {
      this.stack = [newest, ...this.stack.filter((other) => other !== newest)];
    }
    this.focused = newest ?? null;
    this.active = true;
    this.restorer.activate();
    this.restorer.becomeActive();
    if (this.focused) this.lastFocused = this.focused;
  }

  private pick(index: number, eligible: (window: ModelWindow) => boolean): ModelWindow | undefined {
    const candidates = this.windows.filter((window) => !window.closed && eligible(window));
    return candidates.length ? candidates[index % candidates.length] : undefined;
  }
}

type Command =
  | { kind: "open" }
  | { kind: "focus"; index: number }
  | { kind: "minimize"; index: number }
  | { kind: "close"; index: number }
  | { kind: "switchAway" }
  | { kind: "dockClick" };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.constant({ kind: "open" as const }),
  fc.record({ kind: fc.constant("focus" as const), index: fc.nat(8) }),
  fc.record({ kind: fc.constant("minimize" as const), index: fc.nat(8) }),
  fc.record({ kind: fc.constant("close" as const), index: fc.nat(8) }),
  fc.constant({ kind: "switchAway" as const }),
  fc.constant({ kind: "dockClick" as const }),
);

function run(commands: readonly Command[]): void {
  const model = new WindowModel();
  model.open();
  let topAtResign: ModelWindow | undefined;
  for (const command of commands) {
    switch (command.kind) {
      case "open":
      case "focus":
      case "minimize":
        // The operator acts only while the app is active.
        if (!model.active) continue;
        if (command.kind === "open") model.open();
        else if (command.kind === "focus") model.focusWindow(command.index);
        else model.minimize(command.index);
        break;
      case "close":
        // A window can close itself while the app is inactive.
        model.close(command.index);
        break;
      case "switchAway":
        if (model.active) topAtResign = model.lastFocused;
        model.switchAway();
        break;
      case "dockClick": {
        const wasActive = model.active;
        const stackBefore = [...model.stack];
        const onScreenOthers = model.stack.filter((window) => window !== topAtResign);
        model.dockClick();
        if (wasActive) {
          // R3
          expect(model.stack.map((window) => window.id)).toEqual(stackBefore.map((window) => window.id));
          break;
        }
        if (!topAtResign || topAtResign.closed) break;
        if (topAtResign.minimized && onScreenOthers.length > 0) {
          // R2: AppKit's pick stands and the minimized window stays down.
          expect(topAtResign.minimized).toBe(true);
          break;
        }
        // R1 (and R2 when nothing else is on screen)
        expect(model.stack[0]?.id).toBe(topAtResign.id);
        expect(model.focused?.id).toBe(topAtResign.id);
        break;
      }
    }
  }
}

describe("Dock-click window restore", () => {
  it("brings back the window that was on top when the app lost focus", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { minLength: 1, maxLength: 40 }), (commands) => {
        run(commands);
      }),
      { numRuns: 500 },
    );
  });

  it("restores an older window over AppKit's newest-window pick", () => {
    run([
      { kind: "open" },
      { kind: "focus", index: 0 },
      { kind: "switchAway" },
      { kind: "dockClick" },
    ]);
  });
});

describe("selectWindowToRestoreOnActivate", () => {
  function fake(options: { minimized?: boolean; destroyed?: boolean; modal?: boolean; children?: unknown[] } = {}) {
    return {
      focus: () => {},
      restore: () => {},
      getChildWindows: () => options.children ?? [],
      isDestroyed: () => options.destroyed ?? false,
      isMinimized: () => options.minimized ?? false,
      isModal: () => options.modal ?? false,
    } as unknown as ModelWindow;
  }
  const shown = () => true;

  it("prefers a shown modal sheet over its parent", () => {
    const sheet = fake({ modal: true });
    const parent = fake({ children: [sheet] });
    expect(selectWindowToRestoreOnActivate([parent, sheet], parent, shown)).toBe(sheet);
    expect(selectWindowToRestoreOnActivate([parent, sheet], parent, (window) => window !== sheet)).toBe(parent);
  });

  it("restores a minimized window only when nothing else is on screen", () => {
    const minimized = fake({ minimized: true });
    const other = fake();
    expect(selectWindowToRestoreOnActivate([minimized, other], minimized, shown)).toBeUndefined();
    expect(selectWindowToRestoreOnActivate([minimized, other], minimized, (window) => window !== other)).toBe(minimized);
    expect(selectWindowToRestoreOnActivate([minimized, fake({ minimized: true })], minimized, shown)).toBe(minimized);
  });

  it("leaves AppKit's pick for a closed, unowned or never-shown window", () => {
    const destroyed = fake({ destroyed: true });
    const unowned = fake();
    const hidden = fake();
    expect(selectWindowToRestoreOnActivate([destroyed], destroyed, shown)).toBeUndefined();
    expect(selectWindowToRestoreOnActivate([fake()], unowned, shown)).toBeUndefined();
    expect(selectWindowToRestoreOnActivate([hidden], hidden, () => false)).toBeUndefined();
    expect(selectWindowToRestoreOnActivate([hidden], undefined, shown)).toBeUndefined();
  });
});
