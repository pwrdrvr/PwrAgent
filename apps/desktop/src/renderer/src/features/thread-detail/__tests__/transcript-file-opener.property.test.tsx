import { fireEvent, render } from "@testing-library/react";
import type { DesktopApplicationsSnapshot } from "@pwragent/shared";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { scopeDesktopApiToFederationTarget } from "../../../lib/federation-desktop-api";
import { ThreadMarkdown } from "../ThreadMarkdown";

const applications: DesktopApplicationsSnapshot = {
  editors: [{
    id: "zed",
    kind: "editor",
    name: "Zed",
    source: "application",
    appPath: "/Applications/Zed.app",
    canOpenWorkspace: true,
  }],
  terminals: [],
  preferredEditorId: { value: "zed", source: "config" },
  preferredTerminalId: { value: "", source: "default" },
  gh: {
    enabled: { value: false, source: "default" },
    path: { value: "", source: "default" },
    discovery: { candidates: [] },
  },
  git: { path: { value: "", source: "default" }, discovery: { candidates: [] } },
};

function checkSystemOpen(path: string, suffix = "", fileUrl = false): void {
  const openApplication = vi.fn(async () => ({ opened: true as const }));
  const openPath = vi.fn(async () => ({ opened: true as const }));
  const view = render(<ThreadMarkdown
    applications={applications}
    desktopApi={{ openApplication, openPath }}
    text={`[Artifact](<${fileUrl ? "file://" : ""}${encodeURI(path)}${suffix}>)`}
  />);
  try {
    expect(fireEvent.click(view.getByRole("link", { name: "Artifact" }))).toBe(false);
    expect(openPath).toHaveBeenCalledExactlyOnceWith({ path });
    expect(openApplication).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
}

describe("transcript file opener", () => {
  it.each(["app", "exe", "zip", "unknown", "ts", "mp4", "gif", "webp", "pdf", "tex"])("opens .%s in the system default app", (extension) => {
    checkSystemOpen(`/repo/artifact.${extension}`);
  });

  // Opening a file is an OS decision, independent of its type, filename,
  // extension casing, URL encoding, or editor line/column annotations.
  it("keeps system routing independent of file type and link spelling", () => {
    fc.assert(fc.property(
      fc.oneof(fc.constantFrom("app", "exe", "zip", "ts", "md", "json", "pdf"), fc.stringMatching(/^[a-z]{1,10}$/)),
      fc.stringMatching(/^[a-zA-Z0-9 _-]{1,24}$/),
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom("", ":17", ":17:3"),
      (extension, name, uppercase, fileUrl, suffix) => {
        checkSystemOpen(`/repo/folder.pdf/${name}.${uppercase ? extension.toUpperCase() : extension}`, suffix, fileUrl);
      },
    ), { numRuns: 50 });
  });

  it.each([
    ["source.TS", true], ["notes.md", true], ["events.ndjson", true],
    ["main.py", true], [".env.local", true], ["Makefile", true],
    ["repaired.app", false], ["installer.exe", false], ["archive.zip", false],
    ["image.png", false], ["document.pdf", false], ["unknown.custom", false],
  ])("offers an explicit editor button only for recognized text: %s", (name, textFile) => {
    const openPath = vi.fn(async () => ({ opened: true as const }));
    const openApplication = vi.fn(async () => ({ opened: true as const }));
    const path = `/repo/${name}`;
    const view = render(<ThreadMarkdown applications={applications}
      desktopApi={{ openPath, openApplication }} text={`[Artifact](${path}:17:3)`} />);
    try {
      fireEvent.click(view.getByRole("link", { name: "Artifact" }));
      expect(openPath).toHaveBeenCalledExactlyOnceWith({ path });
      expect(openApplication).not.toHaveBeenCalled();
      const button = view.queryByRole("button", { name: "Open file in Zed: Artifact" });
      if (textFile) {
        expect(button).not.toBeNull();
        fireEvent.click(button!);
        expect(openApplication).toHaveBeenCalledExactlyOnceWith({
          applicationId: "zed", kind: "editor", targetPath: path, targetLine: 17, targetColumn: 3,
        });
        expect(openPath).toHaveBeenCalledTimes(1);
      } else {
        expect(button).toBeNull();
      }
    } finally {
      view.unmount();
    }
  });

  it("uses the OS default when no editor is available", () => {
    const openPath = vi.fn(async () => ({ opened: true as const }));
    const view = render(<ThreadMarkdown desktopApi={{ openPath }} text="[Source](/repo/main.ts:12)" />);
    fireEvent.click(view.getByRole("link", { name: "Source" }));
    expect(openPath).toHaveBeenCalledExactlyOnceWith({ path: "/repo/main.ts" });
    expect(view.queryByRole("button")).toBeNull();
  });

  it("does not open a remote owner's media path on the viewer's machine", () => {
    const openPath = vi.fn(async () => ({ opened: true as const }));
    const openApplication = vi.fn(async () => ({ opened: true as const }));
    const view = render(<ThreadMarkdown
      applications={applications}
      desktopApi={scopeDesktopApiToFederationTarget({ openPath, openApplication }, {
        scope: "remote",
        instanceId: "owner",
      })}
      text="[Artifact](/remote/movie.mp4)"
    />);
    expect(fireEvent.click(view.getByRole("link", { name: "Artifact" }))).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
    expect(openApplication).not.toHaveBeenCalled();
  });
});
