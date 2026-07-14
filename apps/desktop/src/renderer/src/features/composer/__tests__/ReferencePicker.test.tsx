import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { NavigationDirectorySummary } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReferencePicker,
  type ReferencePickerProps,
} from "../ReferencePicker";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __pwragentHomeDir?: unknown }).__pwragentHomeDir;
});

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

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    renderPicker({ onClose });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
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
