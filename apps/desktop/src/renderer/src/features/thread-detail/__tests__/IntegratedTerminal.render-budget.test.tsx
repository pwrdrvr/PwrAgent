import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { IntegratedTerminal } from "../IntegratedTerminal";
import type { Terminal } from "@xterm/xterm";

// Operation budgets for the real xterm DOM renderer behind IntegratedTerminal.
//
// The other suite mocks xterm, so it cannot see renderer work. These tests
// run the real @xterm/xterm and @xterm/addon-fit and model the browser
// behavior jsdom lacks:
//
// - Text widths. A rendered element measures its text; one under `hidden`
//   (display:none) measures 0, as in Chromium. xterm's WidthCache keeps only
//   positive widths, so every cell drawn while hidden is measured again, and
//   each measurement forces a style and layout flush.
// - Char size. Chromium measures the cell with an OffscreenCanvas, which
//   works while hidden, so a hidden terminal still has a valid cell size.
// - IntersectionObserver delivery, which pauses xterm's render loop.
// - The device-pixel-ratio media query.
//
// Counters: `widthReads` is one WidthCache measurement (an offsetWidth read
// after a textContent write). `zeroWidthReads` are the ones that measured a
// hidden element. `rowRenders` is one rebuilt row element.

const SESSION = "session-budget";
const CHAR_WIDTH = 7;
const CHAR_HEIGHT = 15;

// Contrived screen: bold, italic, box drawing, CJK wide glyphs, and combining
// marks, so the budgets cover the flat cache, the variant cache, and metrics
// that differ from a single cell.
const SCREEN = [
  "\x1b[1mpwragent\x1b[0m build ok \x1b[32mpassed\x1b[0m 0123456789",
  "┌──────────┐ │ box │ └──────────┘",
  "漢字かな wide glyphs 한국어",
  "é combining ä ô — dash",
  "\x1b[3mitalic\x1b[0m and \x1b[1;3mbold italic\x1b[0m",
  "plain ascii abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ",
].join("\r\n");

const xtermState = vi.hoisted(() => ({ instances: [] as Terminal[] }));

vi.mock("@xterm/xterm", async (importActual) => {
  const actual = await importActual<typeof import("@xterm/xterm")>();
  class TrackedTerminal extends actual.Terminal {
    constructor(...args: ConstructorParameters<typeof actual.Terminal>) {
      super(...args);
      xtermState.instances.push(this);
    }
  }
  return { ...actual, Terminal: TrackedTerminal };
});

const nerdFontState = vi.hoisted(() => ({
  lookup: undefined as Promise<string | undefined> | undefined,
}));

vi.mock("../../../lib/nerd-font-fallback", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../lib/nerd-font-fallback")>();
  return {
    ...actual,
    discoveredNerdFontFamily: () => undefined,
    discoverNerdFontFamily: () =>
      nerdFontState.lookup ?? Promise.resolve(undefined),
  };
});

const counters = { widthReads: 0, zeroWidthReads: 0, rowRenders: 0 };
const viewport = { width: 720, height: 300 };
const dprListeners = new Set<() => void>();
const intersection = { observers: new Set<FakeIntersectionObserver>() };
const restorers: Array<() => void> = [];

function resetCounters() {
  counters.widthReads = 0;
  counters.zeroWidthReads = 0;
  counters.rowRenders = 0;
}

function budget() {
  return { ...counters };
}

function isRendered(element: Element): boolean {
  return element.isConnected && !element.closest("[hidden]");
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const COMBINING = /\p{M}/u;

function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += COMBINING.test(char) ? 0 : WIDE.test(char) ? CHAR_WIDTH * 2 : CHAR_WIDTH;
  }
  return width;
}

class FakeIntersectionObserver {
  private readonly delivered = new Map<Element, boolean>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    intersection.observers.add(this);
  }
  observe(target: Element) {
    this.delivered.set(target, undefined as unknown as boolean);
  }
  unobserve(target: Element) {
    this.delivered.delete(target);
  }
  disconnect() {
    intersection.observers.delete(this);
  }
  takeRecords() {
    return [];
  }
  /** Chromium delivers once after observe and again on every change. */
  deliver() {
    for (const [target, last] of this.delivered) {
      const visible = isRendered(target);
      if (last === visible) continue;
      this.delivered.set(target, visible);
      this.callback([{
        target,
        isIntersecting: visible,
        intersectionRatio: visible ? 1 : 0,
      } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function defineOn(target: object, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorers.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else delete (target as Record<string, unknown>)[key];
  });
}

function installBrowserModel() {
  defineOn(HTMLElement.prototype, "offsetWidth", {
    get(this: HTMLElement) {
      if (!this.classList.contains("xterm-char-measure-element")) return 0;
      const width = isRendered(this) ? textWidth(this.textContent ?? "") : 0;
      if (this.parentElement?.classList.contains("xterm-width-cache-measure-container")) {
        counters.widthReads += 1;
        if (width === 0) counters.zeroWidthReads += 1;
      }
      return width;
    },
  });
  defineOn(HTMLElement.prototype, "offsetHeight", {
    get(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") && isRendered(this)
        ? CHAR_HEIGHT : 0;
    },
  });
  const replaceChildren = Element.prototype.replaceChildren;
  defineOn(Element.prototype, "replaceChildren", {
    value(this: Element, ...nodes: Array<Node | string>) {
      if (this.parentElement?.classList.contains("xterm-rows")) counters.rowRenders += 1;
      return replaceChildren.apply(this, nodes);
    },
    writable: true,
  });
  // Chromium's cell measurement: canvas text metrics, valid while hidden.
  defineOn(globalThis, "OffscreenCanvas", {
    value: class {
      getContext() {
        return {
          font: "",
          measureText: (text: string) => ({
            width: textWidth(text),
            fontBoundingBoxAscent: 12,
            fontBoundingBoxDescent: CHAR_HEIGHT - 12,
          }),
        };
      }
    },
    writable: true,
  });
  defineOn(window, "IntersectionObserver", { value: FakeIntersectionObserver, writable: true });
  defineOn(window, "ResizeObserver", { value: FakeResizeObserver, writable: true });
  defineOn(window, "devicePixelRatio", { value: 1, writable: true });
  defineOn(window, "matchMedia", {
    value: (media: string) => ({
      media,
      matches: false,
      addListener: (listener: () => void) => dprListeners.add(listener),
      removeListener: (listener: () => void) => dprListeners.delete(listener),
      addEventListener: (_type: string, listener: () => void) => dprListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => dprListeners.delete(listener),
    }),
    writable: true,
  });
  // FitAddon reads the host's computed size. A display:none host reports
  // its specified `height: 100%`, not a pixel size, as Chromium does.
  const getComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    let overrides: Record<string, string> | undefined;
    if (element.classList.contains("integrated-terminal__viewport")) {
      overrides = isRendered(element)
        ? { width: `${viewport.width}px`, height: `${viewport.height}px` }
        : { width: "100%", height: "100%" };
    } else if (element.classList.contains("xterm")) {
      overrides = { "padding-top": "0px", "padding-bottom": "0px", "padding-left": "0px", "padding-right": "0px" };
    }
    if (!overrides) return style;
    const values = overrides;
    return new Proxy(style, {
      get(target, key) {
        if (key === "getPropertyValue") {
          return (name: string) => values[name] ?? target.getPropertyValue(name);
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
}

/** Lets observers, animation frames, and xterm's idle tasks run. */
async function settle(rounds = 5) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      for (const observer of intersection.observers) observer.deliver();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function terminalApi() {
  const listeners = new Set<(event: { sessionId: string; data: string; seq?: number }) => void>();
  const raw = {
    platform: "darwin",
    createIntegratedTerminal: vi.fn(async () => ({
      sessionId: SESSION,
      threadKey: "codex:thread-budget",
      cwd: "/repo/budget",
      shell: "/bin/zsh",
      status: "running",
      snapshot: { seq: 1, cols: 100, rows: 20, data: SCREEN },
    })),
    writeIntegratedTerminal: vi.fn(async () => undefined),
    resizeIntegratedTerminal: vi.fn(async () => undefined),
    showIntegratedTerminalContextMenu: vi.fn(async () => undefined),
    onIntegratedTerminalOutput: vi.fn((listener: (event: { sessionId: string; data: string; seq?: number }) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    onIntegratedTerminalExit: vi.fn(() => () => undefined),
    onIntegratedTerminalError: vi.fn(() => () => undefined),
  };
  let seq = 1;
  return {
    api: raw as unknown as DesktopApi,
    raw,
    listeners,
    emit: (data: string) => {
      seq += 1;
      act(() => { for (const listener of listeners) listener({ sessionId: SESSION, data, seq }); });
    },
  };
}

type ViewProps = { visible: boolean; height?: number; onHiddenOutput?: () => void };

function mount(api: DesktopApi, initial: ViewProps) {
  const view = ({ visible, height = 260, onHiddenOutput }: ViewProps) => (
    <IntegratedTerminal desktopApi={api} threadKey="codex:thread-budget" sessionId={SESSION}
      attachOnly height={height} visible={visible} onHiddenOutput={onHiddenOutput}
      onClose={() => undefined} onExit={() => undefined} />
  );
  const result = render(view(initial));
  return { ...result, show: (props: ViewProps) => result.rerender(view(props)) };
}

async function attached(): Promise<Terminal> {
  await waitFor(() => expect(xtermState.instances).toHaveLength(1));
  const terminal = xtermState.instances[0]!;
  await waitFor(() => expect(lineText(terminal, 2)).toContain("漢字かな"));
  await settle();
  return terminal;
}

function lineText(terminal: Terminal, row: number): string {
  return terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

/** One WidthCache entry per distinct glyph and weight/style on screen, plus
 *  the 'W' xterm measures for its default letter spacing. */
function distinctGlyphs(terminal: Terminal): number {
  const keys = new Set<string>(["W"]);
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < terminal.cols; x += 1) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      keys.add(`${cell.getChars() || " "}|${cell.isBold()}|${cell.isItalic()}`);
    }
  }
  return keys.size;
}

/** Letter-spacing xterm had to add to fit glyphs into their cells. With real
 *  widths there is none: the row container's default is 0 and no span
 *  overrides it. A width measured while hidden (0) sets a cell-wide default,
 *  which every span then cancels with an inline style. */
function spacingCorrections(container: HTMLElement): string[] {
  const rows = container.querySelector<HTMLElement>(".xterm-rows");
  const corrections = rows && rows.style.letterSpacing !== "0px"
    ? [`rows:${rows.style.letterSpacing}`] : [];
  return corrections.concat([...container.querySelectorAll<HTMLElement>(".xterm-rows span")]
    .filter((span) => span.style.letterSpacing !== "")
    .map((span) => `${span.textContent}:${span.style.letterSpacing}`));
}

describe("IntegratedTerminal render budget (real xterm)", () => {
  beforeEach(() => {
    xtermState.instances.length = 0;
    nerdFontState.lookup = undefined;
    FakeResizeObserver.instances = [];
    dprListeners.clear();
    viewport.width = 720;
    viewport.height = 300;
    installBrowserModel();
    resetCounters();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    while (restorers.length) restorers.pop()!();
  });

  it("attaches a hidden pane and keeps its output without measuring or drawing rows", async () => {
    const terminal = terminalApi();
    const onHiddenOutput = vi.fn();
    const { container } = mount(terminal.api, { visible: false, onHiddenOutput });
    const xterm = await attached();

    // A background TUI: alternate screen in and out, then more output.
    terminal.emit("\x1b[?1049h\x1b[Hfull-screen app 漢字\x1b[?1049l\r\nback at the prompt ┌┐\r\n");
    await settle();

    expect(budget()).toEqual({ widthReads: 0, zeroWidthReads: 0, rowRenders: 0 });
    expect(onHiddenOutput).toHaveBeenCalled();
    expect(lineText(xterm, 0)).toContain("pwragent build ok passed");
    expect(xterm.buffer.active.getLine(xterm.buffer.active.cursorY - 1)?.translateToString(true))
      .toContain("back at the prompt ┌┐");
    // Nothing for assistive tech to reach in a pane nobody can see.
    expect(container.querySelector(".xterm-helper-textarea")).toBeNull();
  });

  it("draws a hidden-mounted pane on first show with each glyph measured once at its real width", async () => {
    const terminal = terminalApi();
    const { container, show } = mount(terminal.api, { visible: false });
    const xterm = await attached();
    terminal.raw.resizeIntegratedTerminal.mockClear();
    resetCounters();

    show({ visible: true });
    await settle();

    const shown = budget();
    expect(shown.zeroWidthReads).toBe(0);
    expect(shown.widthReads).toBeLessThanOrEqual(distinctGlyphs(xterm));
    expect(spacingCorrections(container)).toEqual([]);
    expect(container.querySelector(".xterm-rows")).toHaveTextContent("漢字かな wide glyphs 한국어");
    expect(container.querySelector(".xterm-rows")).toHaveTextContent("é combining ä ô");
    // One fit to the pane, sent once to the shared PTY.
    expect(xterm.cols).toBe(Math.floor((viewport.width - 14) / CHAR_WIDTH));
    expect(terminal.raw.resizeIntegratedTerminal).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION, cols: xterm.cols, rows: xterm.rows,
    });
    expect(container.querySelectorAll(".xterm-helper-textarea")).toHaveLength(1);
    expect(document.activeElement).toBe(container.querySelector(".xterm-helper-textarea"));

    // Selection and copy work on a pane that opened late.
    xterm.select(0, 0, 8);
    expect(xterm.getSelection()).toBe("pwragent");
    fireEvent.contextMenu(container.querySelector(".integrated-terminal__viewport")!);
    expect(terminal.raw.showIntegratedTerminalContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ canCopy: true }),
    );
  });

  it("does no terminal work for an unchanged rerender or an unchanged observer delivery", async () => {
    const terminal = terminalApi();
    const { show } = mount(terminal.api, { visible: true });
    const xterm = await attached();
    terminal.raw.resizeIntegratedTerminal.mockClear();
    resetCounters();

    show({ visible: true });
    act(() => { for (const observer of FakeResizeObserver.instances) observer.callback(); });
    await settle();

    expect(budget()).toEqual({ widthReads: 0, zeroWidthReads: 0, rowRenders: 0 });
    // A fit re-sends the current grid; main deduplicates it, and re-sends
    // after a refused resize depend on that. It must not be a new grid.
    for (const [request] of terminal.raw.resizeIntegratedTerminal.mock.calls as unknown as Array<[unknown]>) {
      expect(request).toEqual({ sessionId: SESSION, cols: xterm.cols, rows: xterm.rows });
    }
    expect(terminal.raw.resizeIntegratedTerminal.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("re-fits an actual resize once and re-measures nothing", async () => {
    const terminal = terminalApi();
    const { show } = mount(terminal.api, { visible: true });
    const xterm = await attached();
    const rowsBefore = xterm.rows;
    terminal.raw.resizeIntegratedTerminal.mockClear();
    resetCounters();

    viewport.height = 400;
    show({ visible: true, height: 360 });
    act(() => { for (const observer of FakeResizeObserver.instances) observer.callback(); });
    await settle();

    expect(xterm.rows).toBeGreaterThan(rowsBefore);
    expect(terminal.raw.resizeIntegratedTerminal).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION, cols: xterm.cols, rows: xterm.rows,
    });
    const resized = budget();
    expect(resized.widthReads).toBe(0);
    // xterm redraws the grid for the resize itself, its refresh, and the
    // selection clear a row change triggers. Bound it so a loop shows up.
    expect(resized.rowRenders).toBeLessThanOrEqual(4 * xterm.rows);
  });

  it("pauses a shown pane while hidden and re-measures nothing when shown again", async () => {
    const terminal = terminalApi();
    const { show } = mount(terminal.api, { visible: true });
    await attached();
    resetCounters();

    show({ visible: false });
    await settle();
    terminal.emit("more output with known glyphs 0123\r\n");
    await settle();
    const hidden = budget();
    expect(hidden.zeroWidthReads).toBe(0);
    expect(hidden.widthReads).toBe(0);

    resetCounters();
    show({ visible: true });
    await settle();
    expect(budget().widthReads).toBe(0);
    expect(budget().rowRenders).toBeGreaterThan(0);
  });

  it("re-measures each glyph once for a device-pixel-ratio change, and not at all while never shown", async () => {
    const hiddenTerminal = terminalApi();
    mount(hiddenTerminal.api, { visible: false });
    await attached();
    resetCounters();
    act(() => {
      (window as { devicePixelRatio: number }).devicePixelRatio = 2;
      for (const listener of [...dprListeners]) listener();
    });
    await settle();
    expect(budget()).toEqual({ widthReads: 0, zeroWidthReads: 0, rowRenders: 0 });
    cleanup();

    xtermState.instances.length = 0;
    (window as { devicePixelRatio: number }).devicePixelRatio = 1;
    const visibleTerminal = terminalApi();
    mount(visibleTerminal.api, { visible: true });
    const xterm = await attached();
    resetCounters();
    act(() => {
      (window as { devicePixelRatio: number }).devicePixelRatio = 2;
      for (const listener of [...dprListeners]) listener();
    });
    await settle();
    const changed = budget();
    expect(changed.zeroWidthReads).toBe(0);
    expect(changed.widthReads).toBeGreaterThan(0);
    expect(changed.widthReads).toBeLessThanOrEqual(distinctGlyphs(xterm));
  });

  it("applies a late Nerd Font to a hidden pane without measuring, then measures once on show", async () => {
    let resolveFont!: (family: string) => void;
    nerdFontState.lookup = new Promise((resolve) => { resolveFont = resolve; });
    const terminal = terminalApi();
    const { container, show } = mount(terminal.api, { visible: false });
    const xterm = await attached();
    resetCounters();

    await act(async () => { resolveFont("Symbols Nerd Font Mono"); });
    await settle();
    expect(xterm.options.fontFamily).toContain("Symbols Nerd Font Mono");
    expect(budget()).toEqual({ widthReads: 0, zeroWidthReads: 0, rowRenders: 0 });

    show({ visible: true });
    await settle();
    const shown = budget();
    expect(shown.zeroWidthReads).toBe(0);
    expect(shown.widthReads).toBeLessThanOrEqual(distinctGlyphs(xterm));
    expect(spacingCorrections(container)).toEqual([]);
  });

  it("disposes a never-shown pane and a shown pane without leaving work behind", async () => {
    const hidden = terminalApi();
    const first = mount(hidden.api, { visible: false });
    const hiddenXterm = await attached();
    const disposeHidden = vi.spyOn(hiddenXterm, "dispose");
    first.unmount();
    expect(disposeHidden).toHaveBeenCalledTimes(1);
    expect(hidden.listeners.size).toBe(0);

    xtermState.instances.length = 0;
    const shown = terminalApi();
    const second = mount(shown.api, { visible: true });
    await attached();
    second.unmount();
    expect(shown.listeners.size).toBe(0);
    expect(document.querySelector(".xterm")).toBeNull();
    expect(document.querySelector(".xterm-width-cache-measure-container")).toBeNull();

    resetCounters();
    await settle();
    expect(budget()).toEqual({ widthReads: 0, zeroWidthReads: 0, rowRenders: 0 });
  });
});
