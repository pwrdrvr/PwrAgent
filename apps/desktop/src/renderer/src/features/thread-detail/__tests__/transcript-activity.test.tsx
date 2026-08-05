import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptActivity } from "../TranscriptActivity";

describe("TranscriptActivity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a direct activity path relative to the longest thread directory", async () => {
    const copyText = vi.fn(async () => undefined);
    const absolutePath =
      "/Users/huntharo/.pwragent/worktrees/ms2ai7od/PwrAgnt/apps/desktop/src/main/acp/acp-runtime-capabilities.ts";
    const label = `Read \`${absolutePath}\``;

    render(
      <TranscriptActivity
        desktopApi={{ copyText }}
        directoryPaths={[
          "/Users/huntharo/pwrdrvr/PwrAgnt",
          "/Users/huntharo/.pwragent/worktrees/ms2ai7od/PwrAgnt",
        ]}
        entry={{
          type: "activity",
          id: "read-1",
          summary: label,
          details: [
            {
              id: "read-1:detail",
              kind: "read",
              label,
              path: absolutePath,
              command: {
                displayCommand: label,
                source: "tool",
                output: "Read 80 lines",
              },
            },
          ],
        }}
      />,
    );

    const displayLabel =
      "Read `apps/desktop/src/main/acp/acp-runtime-capabilities.ts`";
    const toggle = screen.getByRole("button", { name: displayLabel });
    expect(toggle).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy activity" }));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(`${label}\n${label}`);
    });

    fireEvent.click(toggle);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy invocation" })).toBeInTheDocument();
  });

  it("formats nested detail labels while keeping outside paths absolute", () => {
    const projectPath = "/repo/PwrAgnt/apps/desktop/src/main.ts";
    const outsidePath = "/repo/PwrAgnt-other/scripts/release.ts";

    render(
      <TranscriptActivity
        directoryPaths={["/repo/PwrAgnt"]}
        entry={{
          type: "activity",
          id: "reads-1",
          summary: "Read 2 files",
          details: [
            {
              id: "read-project",
              kind: "read",
              label: `Read \`${projectPath}\``,
              path: projectPath,
            },
            {
              id: "read-outside",
              kind: "read",
              label: `Read \`${outsidePath}\``,
              path: outsidePath,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Read 2 files" }));

    expect(screen.getByText("Read `apps/desktop/src/main.ts`")).toBeInTheDocument();
    expect(screen.getByText(`Read \`${outsidePath}\``)).toBeInTheDocument();
  });

  it("does not replace a matching path prefix inside an outside path", () => {
    const projectPath = "/repo/PwrAgnt";
    const outsidePath = "/repo/PwrAgnt-old/file.ts";

    render(
      <TranscriptActivity
        directoryPaths={[projectPath]}
        entry={{
          type: "activity",
          id: "shared-prefix-paths",
          summary: `Compared \`${projectPath}\` with \`${outsidePath}\``,
          details: [
            {
              id: "project-path",
              kind: "read",
              label: `Read \`${projectPath}\``,
              path: projectPath,
            },
            {
              id: "outside-path",
              kind: "read",
              label: `Read \`${outsidePath}\``,
              path: outsidePath,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: `Compared \`.\` with \`${outsidePath}\``,
      }),
    ).toBeInTheDocument();
  });
});
