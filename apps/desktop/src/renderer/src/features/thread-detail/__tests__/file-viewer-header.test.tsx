import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileViewerHeader, splitFilePath } from "../FileViewerHeader";

describe("FileViewerHeader", () => {
  it("names the file once and copies its full path from the folder", async () => {
    const copyText = vi.fn(async () => undefined);
    render(
      <FileViewerHeader
        actions={<button type="button">Close</button>}
        desktopApi={{ copyText }}
        headingLevel={2}
        kind="html"
        path="/work/atlas/docs/Atlas Launch Plan.html"
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Atlas Launch Plan.html" })).toBeInTheDocument();
    expect(screen.getByText("HTML")).toHaveAttribute("aria-hidden", "true");
    const folder = screen.getByRole("button", { name: "Copy path" });
    expect(folder).toHaveTextContent(/^\/work\/atlas\/docs$/);
    expect(folder).toHaveAttribute("data-tooltip", "/work/atlas/docs/Atlas Launch Plan.html");

    fireEvent.click(folder);
    await waitFor(() => expect(folder).toHaveAttribute("data-copied", "true"));
    expect(copyText).toHaveBeenCalledWith("/work/atlas/docs/Atlas Launch Plan.html");
    expect(folder).toHaveAttribute("data-tooltip", "Copied path");
  });

  it("shows the placeholder and no path controls when no file is selected", () => {
    render(
      <FileViewerHeader actions={null} headingLevel={1} placeholder="No file selected" />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "No file selected" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  });

  it("splits POSIX and Windows paths at the last separator", () => {
    expect(splitFilePath("/work/notes.md")).toEqual({ folder: "/work", name: "notes.md" });
    expect(splitFilePath("/notes.md")).toEqual({ folder: "/", name: "notes.md" });
    expect(splitFilePath("C:\\Users\\me\\notes.md")).toEqual({ folder: "C:\\Users\\me", name: "notes.md" });
    expect(splitFilePath("C:\\notes.md")).toEqual({ folder: "C:\\", name: "notes.md" });
    expect(splitFilePath("notes.md")).toEqual({ folder: "", name: "notes.md" });
  });
});
