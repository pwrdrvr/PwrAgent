import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { NavigationDirectorySummary } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReferencePicker,
  type ReferencePickerProps,
} from "../ReferencePicker";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "../native-picker-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir;
});

/** Stub the panel's measured rect so the viewport clamp sees real geometry
 *  (jsdom rects are all zeros otherwise). */
function mockPanelRect(left: number, right: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left,
    right,
    top: 0,
    bottom: 420,
    width: right - left,
    height: 420,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

type RowLayout = {
  /** The trigger's right edge, where the unshifted panel's right edge sits. */
  triggerRight: number;
  naturalWidth: number;
  row: { left: number; right: number };
};

/** Lay the panel out from its trigger and its own inline clamp style, inside
 *  a `.composer__setup` row, the way the browser does. Mutate `layout` to
 *  move the trigger or resize the row. */
function mockRowLayout(layout: RowLayout): void {
  const rect = (left: number, right: number): DOMRect => ({
    left,
    right,
    top: 0,
    bottom: 420,
    width: right - left,
    height: 420,
    x: left,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function getBoundingClientRect(this: Element) {
      if (this.classList.contains("composer__setup")) {
        return rect(layout.row.left, layout.row.right);
      }
      if (this.classList.contains("reference-picker__pop")) {
        const style = (this as HTMLElement).style;
        const shift = Number(
          /translateX\((-?[\d.]+)px\)/.exec(style.transform)?.[1] ?? 0,
        );
        const width = style.maxWidth
          ? Number.parseFloat(style.maxWidth)
          : layout.naturalWidth;
        const right = layout.triggerRight + shift;
        return rect(right - width, right);
      }
      return rect(0, 0);
    },
  );
}

const dirA: NavigationDirectorySummary = {
  key: "directory:/Users/me/code/PwrAgent",
  kind: "directory",
  label: "PwrAgent",
  path: "/Users/me/code/PwrAgent",
  threadKeys: [],
  needsAttentionCount: 0,
  latestUpdatedAt: 1_000,
};

const dirB: NavigationDirectorySummary = {
  key: "directory:/Users/me/code/PwrSnap",
  kind: "directory",
  label: "PwrSnap",
  path: "/Users/me/code/PwrSnap",
  threadKeys: [],
  needsAttentionCount: 0,
  latestUpdatedAt: 2_000,
};

const unlinked: NavigationDirectorySummary = {
  key: "unlinked",
  kind: "unlinked",
  label: "No linked directory",
  threadKeys: [],
  needsAttentionCount: 0,
};

const recentFiles = [
  { label: "spec.md", path: "/Users/me/notes/spec.md" },
  { label: "todo.txt", path: "/Users/me/notes/todo.txt" },
];

function renderPicker(
  overrides: Partial<ReferencePickerProps> = {},
): ReturnType<typeof render> {
  const props: ReferencePickerProps = {
    open: true,
    onClose: () => undefined,
    directories: [],
    recentFiles: [],
    onSelectDirectory: () => undefined,
    onSelectFile: () => undefined,
    ...overrides,
  };
  return render(<ReferencePicker {...props} />);
}

describe("ReferencePicker", () => {
  it("opens on the Projects tab with recent directories sorted by latestUpdatedAt desc", () => {
    renderPicker({ directories: [dirA, dirB, unlinked] });

    expect(
      screen.getByRole("dialog", { name: "Add reference" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    const rows = screen.getAllByRole("option");
    // The "unlinked" pseudo-directory is filtered out.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("PwrSnap");
    expect(rows[1]).toHaveTextContent("PwrAgent");
  });

  it("switches to the Files tab and lists recent files with tilde paths", () => {
    (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir =
      "/Users/me";
    renderPicker({ directories: [dirA], recentFiles });

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("spec.md");
    expect(rows[0]).toHaveTextContent("~/notes/spec.md");
    expect(rows[1]).toHaveTextContent("todo.txt");
    // The projects list is replaced, not stacked.
    expect(screen.queryByText("PwrAgent")).not.toBeInTheDocument();
  });

  it("invokes onSelectDirectory with the row's label and path", () => {
    const onSelectDirectory = vi.fn();
    renderPicker({ directories: [dirA], onSelectDirectory });

    fireEvent.click(screen.getByRole("option", { name: /pwragent/i }));

    expect(onSelectDirectory).toHaveBeenCalledExactlyOnceWith({
      label: "PwrAgent",
      path: "/Users/me/code/PwrAgent",
    });
  });

  it("invokes onSelectFile with the row's path", () => {
    const onSelectFile = vi.fn();
    renderPicker({ recentFiles, onSelectFile });

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("option", { name: /spec\.md/i }));

    expect(onSelectFile).toHaveBeenCalledExactlyOnceWith(
      "/Users/me/notes/spec.md",
    );
  });

  it("shows the empty Files state copy when there are no recent files", () => {
    renderPicker({ recentFiles: [] });

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(
      screen.getByText(
        "No recent files. Drop files on the composer or add one below.",
      ),
    ).toBeInTheDocument();
  });

  it("filters the active tab by the search query", () => {
    renderPicker({ directories: [dirA, dirB], recentFiles });

    fireEvent.change(screen.getByPlaceholderText("Find a directory"), {
      target: { value: "snap" },
    });
    let rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("PwrSnap");

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.change(screen.getByPlaceholderText("Find a file"), {
      target: { value: "todo" },
    });
    rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("todo.txt");
  });

  it("renders ONE combined add row on darwin", () => {
    const onPickFromDisk = vi.fn();
    renderPicker({
      platform: "darwin",
      onPickFromDisk,
      onPickDirectoryFromDisk: () => undefined,
      onPickFileFromDisk: () => undefined,
    });

    const combined = screen.getByRole("button", {
      name: "Add file or directory…",
    });
    expect(
      screen.queryByRole("button", { name: "Add directory…" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add file…" }),
    ).not.toBeInTheDocument();

    fireEvent.click(combined);
    expect(onPickFromDisk).toHaveBeenCalledOnce();
  });

  it("renders separate directory/file add rows off-macOS", () => {
    const onPickDirectoryFromDisk = vi.fn();
    const onPickFileFromDisk = vi.fn();
    renderPicker({
      platform: "linux",
      onPickFromDisk: () => undefined,
      onPickDirectoryFromDisk,
      onPickFileFromDisk,
    });

    expect(
      screen.queryByRole("button", { name: "Add file or directory…" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add directory…" }));
    expect(onPickDirectoryFromDisk).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Add file…" }));
    expect(onPickFileFromDisk).toHaveBeenCalledOnce();
  });

  it("keeps native add rows visible but disabled in remote viewers", () => {
    const onPickDirectoryFromDisk = vi.fn();
    const onPickFileFromDisk = vi.fn();
    renderPicker({
      nativePickingDisabled: true,
      onPickDirectoryFromDisk,
      onPickFileFromDisk,
    });

    const directory = screen.getByRole("button", { name: "Add directory…" });
    const file = screen.getByRole("button", { name: "Add file…" });
    expect(directory).toBeDisabled();
    expect(file).toBeDisabled();
    expect(directory).toHaveAttribute("title", REMOTE_NATIVE_PICKER_TOOLTIP);
    expect(file).toHaveAttribute("data-tooltip", REMOTE_NATIVE_PICKER_TOOLTIP);
    fireEvent.click(directory);
    fireEvent.click(file);
    expect(onPickDirectoryFromDisk).not.toHaveBeenCalled();
    expect(onPickFileFromDisk).not.toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    renderPicker({ onClose });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("nudges the panel left when it would overflow the right viewport gutter", () => {
    // jsdom viewport is 1024 wide; gutter is 12 → right limit 1012.
    mockPanelRect(800, 1240);
    renderPicker({ directories: [dirA] });

    expect(screen.getByRole("dialog", { name: "Add reference" })).toHaveStyle({
      transform: "translateX(-228px)",
    });
  });

  it("nudges the panel right when it would overflow the left viewport gutter", () => {
    mockPanelRect(-50, 390);
    renderPicker({ directories: [dirA] });

    expect(screen.getByRole("dialog", { name: "Add reference" })).toHaveStyle({
      transform: "translateX(62px)",
    });
  });

  it("leaves the panel unshifted when it already fits the viewport", () => {
    mockPanelRect(100, 540);
    renderPicker({ directories: [dirA] });

    expect(
      screen.getByRole("dialog", { name: "Add reference" }),
    ).not.toHaveAttribute("style");
  });

  it("clamps the panel to the composer's settings row, not just the window", () => {
    // Measured at 1280x800 with the sidebar and context rail open. The main
    // pane is overflow-hidden and starts at 408, so a window-only clamp left
    // this 316..756 panel 92px under the sidebar.
    mockRowLayout({
      naturalWidth: 440,
      row: { left: 424, right: 836 },
      triggerRight: 755.890625,
    });
    render(
      <div className="composer__setup">
        <ReferencePicker
          directories={[dirA]}
          open
          recentFiles={[]}
          onClose={() => undefined}
          onSelectDirectory={() => undefined}
          onSelectFile={() => undefined}
        />
      </div>,
    );

    expect(screen.getByRole("dialog", { name: "Add reference" })).toHaveStyle({
      maxWidth: "412px",
      minWidth: "412px",
      transform: "translateX(80.109375px)",
    });
  });

  it("re-clamps when the settings row resizes without a window resize", () => {
    // Shrinking the window changes the pinned rail's width, and the layout
    // animates the padding that reserves it, so the row keeps resizing after
    // the last `resize` event. Only an observer on the row sees that.
    const observed: Element[] = [];
    const callbacks: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }

        observe(target: Element): void {
          observed.push(target);
        }

        disconnect(): void {}
      },
    );
    const layout: RowLayout = {
      naturalWidth: 440,
      row: { left: 424, right: 836 },
      triggerRight: 755.890625,
    };
    mockRowLayout(layout);
    const { container } = render(
      <div className="composer__setup">
        <ReferencePicker
          directories={[dirA]}
          open
          recentFiles={[]}
          onClose={() => undefined}
          onSelectDirectory={() => undefined}
          onSelectFile={() => undefined}
        />
      </div>,
    );
    expect(observed).toEqual([container.querySelector(".composer__setup")]);

    // The 960x640 layout: the row wraps and the trigger lands at 434.
    layout.row = { left: 376, right: 656 };
    layout.triggerRight = 434;
    act(() => {
      for (const callback of callbacks) {
        callback();
      }
    });

    expect(screen.getByRole("dialog", { name: "Add reference" })).toHaveStyle({
      maxWidth: "280px",
      minWidth: "280px",
      transform: "translateX(222px)",
    });
  });

  it("renders nothing but the trigger child when closed", () => {
    renderPicker({
      open: false,
      children: <button type="button">Add reference</button>,
    });

    expect(
      screen.getByRole("button", { name: "Add reference" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Add reference" }),
    ).not.toBeInTheDocument();
  });
});
