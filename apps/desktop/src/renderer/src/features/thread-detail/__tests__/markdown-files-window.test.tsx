import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadMarkdownFileViewerSnapshotResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { MarkdownFilesWindow } from "../MarkdownFilesWindow";

describe("MarkdownFilesWindow", () => {
  afterEach(() => {
    delete (window as Window & { pwragent?: DesktopApi }).pwragent;
    window.location.hash = "";
  });

  it("renders the selected markdown file with thread and project context", async () => {
    window.location.hash = "#files/codex%3Athread-1";
    const snapshotResponse: ReadMarkdownFileViewerSnapshotResponse = {
      snapshot: {
        context: {
          key: "codex:thread-1",
          title: "Files - Slack-to-Agent automation plan",
          threadTitle: "Slack-to-Agent automation plan",
          projectPath: "/repo/PwrAgent",
        },
        editorApplication: {
          id: "vscode",
          kind: "editor",
          name: "VS Code",
          source: "application",
          appPath: "/Applications/Visual Studio Code.app",
          canOpenWorkspace: true,
        },
        files: [
          {
            path: "/repo/PwrAgent/docs/plan.md",
            label: "docs/plan.md",
          },
        ],
        selectedPath: "/repo/PwrAgent/docs/plan.md",
      },
    };
    const readMarkdownFileViewerSnapshot = vi.fn(async () => snapshotResponse);
    const readMarkdownFile = vi.fn(async () => ({
      path: "/repo/PwrAgent/docs/plan.md",
      content: "# Plan\n\nShip it. See [source](/repo/PwrAgent/src/foo.ts:12).",
    }));
    const openApplication = vi.fn(async () => ({ opened: true as const }));

    (window as Window & { pwragent?: DesktopApi }).pwragent = {
      onMarkdownFileViewerSnapshotChanged: () => () => undefined,
      openApplication,
      readMarkdownFile,
      readMarkdownFileViewerSnapshot,
    };

    render(<MarkdownFilesWindow />);

    expect(
      await screen.findByRole("heading", { name: "docs/plan.md" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "PwrAgent > Slack-to-Agent automation plan > Files",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Project: /repo/PwrAgent")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Plan" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(readMarkdownFileViewerSnapshot).toHaveBeenCalledWith({
        contextKey: "codex:thread-1",
      });
      expect(readMarkdownFile).toHaveBeenCalledWith({
        path: "/repo/PwrAgent/docs/plan.md",
      });
    });

    screen.getByRole("link", { name: "source" }).click();

    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "vscode",
        kind: "editor",
        targetPath: "/repo/PwrAgent/src/foo.ts",
        targetLine: 12,
        targetColumn: undefined,
      });
    });
  });
});
