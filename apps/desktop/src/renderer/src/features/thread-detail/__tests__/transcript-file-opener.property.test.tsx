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
  it.each(["mp4", "gif", "webp", "pdf", "tex"])("opens .%s in the system default app", (extension) => {
    checkSystemOpen(`/repo/artifact.${extension}`);
  });

  // Media and document links choose the system opener regardless of filename,
  // extension casing, URL encoding, or editor line/column annotations.
  it("keeps media and document routing independent of link spelling", () => {
    fc.assert(fc.property(
      fc.constantFrom("mp4", "mov", "webm", "gif", "webp", "png", "svg", "pdf", "tex", "docx", "xlsx", "pptx", "mp3", "wav"),
      fc.stringMatching(/^[a-zA-Z0-9 _-]{1,24}$/),
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom("", ":17", ":17:3"),
      (extension, name, uppercase, fileUrl, suffix) => {
        checkSystemOpen(`/repo/folder.pdf/${name}.${uppercase ? extension.toUpperCase() : extension}`, suffix, fileUrl);
      },
    ), { numRuns: 50 });
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
