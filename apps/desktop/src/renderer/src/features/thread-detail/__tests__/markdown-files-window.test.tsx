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

  it.each([
    { remote: false, kind: "Markdown" },
    { remote: true, kind: "Markdown" },
    { remote: false, kind: "JSON" },
    { remote: true, kind: "JSON" },
  ])("renders the selected $kind file (remote: $remote)", async ({ remote, kind }) => {
    const fileName = kind === "JSON" ? "widget.json" : "plan.md";
    const federationTarget = remote ? { scope: "remote" as const, instanceId: "owner" } : undefined;
    const thread = { backend: "codex" as const, threadId: "thread-1" };
    window.location.hash = "#files/codex%3Athread-1";
    const snapshotResponse: ReadMarkdownFileViewerSnapshotResponse = {
      snapshot: {
        context: {
          federationTarget,
          thread,
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
            path: `/repo/PwrAgent/docs/${fileName}`,
            label: `docs/${fileName}`,
          },
        ],
        selectedPath: `/repo/PwrAgent/docs/${fileName}`,
      },
    };
    const readMarkdownFileViewerSnapshot = vi.fn(async () => snapshotResponse);
    const readMarkdownFile = vi.fn(async () => ({
      path: `/repo/PwrAgent/docs/${fileName}`,
      content: kind === "JSON" ? '{"title":"Widget"}' : "# Plan\n\nShip it. See [source](/repo/PwrAgent/src/foo.ts:12).",
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
      await screen.findByRole("heading", { name: `docs/${fileName}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("PwrAgent > Slack-to-Agent automation plan > Files"),
    ).toBeInTheDocument();
    expect(screen.getByText("Project: /repo/PwrAgent")).toBeInTheDocument();
    if (kind === "JSON") {
      expect(await screen.findByLabelText("JSON contents")).toHaveTextContent('"title": "Widget"');
    } else {
      expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
    }
    await waitFor(() => {
      expect(readMarkdownFileViewerSnapshot).toHaveBeenCalledWith({
        contextKey: "codex:thread-1",
      });
      expect(readMarkdownFile).toHaveBeenCalledWith({
        ...(remote ? { federationTarget } : {}),
        thread,
        path: `/repo/PwrAgent/docs/${fileName}`,
      });
    });

    if (kind === "JSON") {
      screen.getByRole("button", { name: `Open file in VS Code: docs/${fileName}` }).click();
    } else {
      screen.getByRole("link", { name: "source" }).click();
    }

    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        ...(remote ? { federationTarget } : {}),
        applicationId: "vscode",
        kind: "editor",
        targetPath: kind === "JSON" ? `/repo/PwrAgent/docs/${fileName}` : "/repo/PwrAgent/src/foo.ts",
        targetLine: kind === "JSON" ? undefined : 12,
        targetColumn: undefined,
      });
    });
  });
});
