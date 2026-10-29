import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptFileReference, type DesktopApplicationsSnapshot, type ResolveTranscriptFilesRequest, type ResolveTranscriptFilesResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { scopeDesktopApiToFederationTarget } from "../../../lib/federation-desktop-api";
import { ThreadMarkdown } from "../ThreadMarkdown";

vi.mock("@pwragent/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pwragent/shared")>();
  return { ...actual, transcriptFileReference: vi.fn(actual.transcriptFileReference) };
});

afterEach(() => vi.mocked(transcriptFileReference).mockClear());

const applications: DesktopApplicationsSnapshot = {
  editors: [{ id: "code", kind: "editor", name: "VS Code", source: "application", appPath: "/fixture/Code.app", canOpenWorkspace: true }],
  terminals: [],
  preferredEditorId: { value: "code", source: "config" },
  preferredTerminalId: { value: "", source: "default" },
  gh: { enabled: { value: false, source: "default" }, path: { value: "", source: "default" }, discovery: { candidates: [] } },
  git: { path: { value: "", source: "default" }, discovery: { candidates: [] } },
};
const context = { key: "thread-1", title: "Files", projectPath: "/owner/project", thread: { backend: "acp:grok" as const, threadId: "thread-1" } };

describe("inline file links", () => {
  it("keeps filenames literal on surfaces without an owning file context", () => {
    const resolveTranscriptFiles = vi.fn();
    render(<ThreadMarkdown desktopApi={{ resolveTranscriptFiles }} text="Read `/owner/notes.md`." />);
    expect(resolveTranscriptFiles).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("collects only unlinked inline-code filenames, including tables, and deduplicates them", async () => {
    const resolveTranscriptFiles = vi.fn(async () => ({ files: [] }));
    render(<ThreadMarkdown desktopApi={{ resolveTranscriptFiles }} fileViewerContext={context} text={[
      "Read `research/pwr-video-pilot/NOTES.md` and `research/pwr-video-pilot/NOTES.md`.",
      "[`linked.md`](/explicit.md) and `seek(t)` and `#000000` and `npm install` and `https://example.com/doc.md`.",
      "```", "fenced.md", "```",
      "| File |", "| --- |", "| `code.ts:3:2` |",
      "[reference.md][ref]", "[ref]: /ref.md",
    ].join("\n")} />);
    await waitFor(() => expect(resolveTranscriptFiles).toHaveBeenCalledTimes(1));
    expect(resolveTranscriptFiles).toHaveBeenCalledWith(expect.objectContaining({ references: ["research/pwr-video-pilot/NOTES.md", "code.ts:3:2"] }));
  });

  it("hydrates the reported relative Markdown paths and opens preview and detached viewers", async () => {
    const reference = "research/pwr-video-pilot/NOTES.md";
    const path = `/owner/project/${reference}`;
    const resolveTranscriptFiles = vi.fn(async () => ({ files: [{ reference, path, previewable: true }] }));
    const readMarkdownFile = vi.fn(async () => ({ path, content: "# Pilot notes" }));
    const openMarkdownFileViewer = vi.fn(async () => ({ opened: true as const }));
    render(<ThreadMarkdown fileViewerContext={context} desktopApi={{ resolveTranscriptFiles, readMarkdownFile, openMarkdownFileViewer }}
      text={`Notes: \`${reference}\` and \`research/pwr-video-pilot/PILOT.md\`.`} />);
    const chip = await screen.findByRole("link", { name: reference });
    // A file chip, not inline code: it says what a click does.
    expect(chip).toHaveClass("thread-markdown__file-chip");
    expect(chip).toHaveAttribute("data-tooltip", expect.stringMatching(/^Preview .*\/NOTES\.md$/));
    fireEvent.click(chip);
    expect(await screen.findByRole("heading", { name: "Pilot notes" })).toBeInTheDocument();
    // The header names the file once, though the link text was its path.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { level: 2, name: "NOTES.md" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy path" }))
      .toHaveTextContent(/^\/owner\/project\/research\/pwr-video-pilot$/);
    expect(within(dialog).queryByText(reference)).toBeNull();
    expect(resolveTranscriptFiles).toHaveBeenCalledWith(expect.objectContaining({
      references: [reference, "research/pwr-video-pilot/PILOT.md"], thread: context.thread, projectPath: context.projectPath,
    }));
    expect(readMarkdownFile).toHaveBeenCalledWith({ path, thread: context.thread });
    fireEvent.click(screen.getByRole("button", { name: "Open in detached files window" }));
    await waitFor(() => expect(openMarkdownFileViewer).toHaveBeenCalledWith(expect.objectContaining({
      context, file: { path, label: reference },
    })));
    expect(screen.queryByRole("link", { name: "research/pwr-video-pilot/PILOT.md" })).toBeNull();
  });

  it("offers an editor action for existing unsupported files and preserves location suffixes", async () => {
    const resolveTranscriptFiles = vi.fn(async () => ({ files: [{ reference: "src/code.ts:8:2", path: "/owner/project/src/code.ts", line: 8, column: 2, previewable: false }] }));
    const openApplication = vi.fn(async () => ({ opened: true as const }));
    const readMarkdownFile = vi.fn();
    render(<ThreadMarkdown applications={applications} fileViewerContext={context}
      desktopApi={{ resolveTranscriptFiles, openApplication, readMarkdownFile }} text="Open `src/code.ts:8:2` and `missing.md`." />);
    fireEvent.click(await screen.findByRole("button", { name: "Open file in VS Code: src/code.ts:8:2" }));
    expect(openApplication).toHaveBeenCalledWith({ applicationId: "code", kind: "editor", targetPath: "/owner/project/src/code.ts", targetLine: 8, targetColumn: 2 });
    expect(screen.queryByRole("link")).toBeNull();
    expect(readMarkdownFile).not.toHaveBeenCalled();
  });

  it("sends stat, preview and editor requests to the remote owner", async () => {
    const federationTarget = { scope: "remote" as const, instanceId: "owner" };
    const resolveTranscriptFiles = vi.fn(async () => ({ files: [{ reference: "notes.md", path: "/remote/notes.md", previewable: true }] }));
    const readMarkdownFile = vi.fn(async () => ({ path: "/remote/notes.md", content: "# Remote notes" }));
    const openApplication = vi.fn(async () => ({ opened: true as const }));
    const api = scopeDesktopApiToFederationTarget({ resolveTranscriptFiles, readMarkdownFile, openApplication } as unknown as DesktopApi, federationTarget);
    render(<ThreadMarkdown applications={applications} fileViewerContext={context} desktopApi={api} text="Read `notes.md`." />);
    fireEvent.click(await screen.findByRole("link", { name: "notes.md" }));
    expect(await screen.findByRole("heading", { name: "Remote notes" })).toBeInTheDocument();
    expect(resolveTranscriptFiles).toHaveBeenCalledWith(expect.objectContaining({ federationTarget, thread: context.thread }));
    expect(readMarkdownFile).toHaveBeenCalledWith({ path: "/remote/notes.md", thread: context.thread, federationTarget });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Open file in VS Code: notes.md" }));
    expect(openApplication).toHaveBeenCalledWith(expect.objectContaining({ federationTarget, targetPath: "/remote/notes.md" }));
  });

  it("ignores late hydration after changing owner context", async () => {
    let finish: (result: ResolveTranscriptFilesResponse) => void = () => undefined;
    const resolveTranscriptFiles = vi.fn((request: ResolveTranscriptFilesRequest) => request.thread?.threadId === "thread-1"
      ? new Promise<ResolveTranscriptFilesResponse>((resolve) => { finish = resolve; })
      : Promise.resolve({ files: [] }));
    const api = { resolveTranscriptFiles, readMarkdownFile: vi.fn() };
    const view = render(<ThreadMarkdown fileViewerContext={context} desktopApi={api} text="Read `notes.md`." />);
    await waitFor(() => expect(resolveTranscriptFiles).toHaveBeenCalledTimes(1));
    view.rerender(<ThreadMarkdown fileViewerContext={{ ...context, thread: { ...context.thread, threadId: "thread-2" } }} desktopApi={api} text="Read `notes.md`." />);
    await act(async () => finish({ files: [{ reference: "notes.md", path: "/old/notes.md", previewable: true }] }));
    expect(screen.queryByRole("link", { name: "notes.md" })).toBeNull();
  });

  it("does not restat unchanged candidates as surrounding text streams", async () => {
    const resolveTranscriptFiles = vi.fn(async () => ({ files: [] }));
    const api = { resolveTranscriptFiles };
    const view = render(<ThreadMarkdown fileViewerContext={context} desktopApi={api} text="Read `notes.md`." />);
    await waitFor(() => expect(resolveTranscriptFiles).toHaveBeenCalledTimes(1));
    view.rerender(<ThreadMarkdown fileViewerContext={{ ...context, title: "Renamed" }} desktopApi={api} text="Read `notes.md`. More prose." />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(resolveTranscriptFiles).toHaveBeenCalledTimes(1);
  });

  it("does not rescan candidates per appended character and stats only newly introduced filenames", async () => {
    const resolveTranscriptFiles = vi.fn(async () => ({ files: [] }));
    const api = { resolveTranscriptFiles };
    const prefix = "Prose ".repeat(500) + "`notes.md` ";
    const view = render(<ThreadMarkdown fileViewerContext={context} desktopApi={api} text={prefix} />);
    await waitFor(() => expect(resolveTranscriptFiles).toHaveBeenCalledTimes(1));
    for (let length = 1; length <= 150; length++) {
      view.rerender(<ThreadMarkdown fileViewerContext={context} desktopApi={api} text={prefix + "x".repeat(length)} />);
    }
    expect(transcriptFileReference).toHaveBeenCalledTimes(1);
    view.rerender(<ThreadMarkdown fileViewerContext={context} desktopApi={api} text={prefix + "x".repeat(150) + " `next.md`"} />);
    await waitFor(() => expect(resolveTranscriptFiles).toHaveBeenCalledTimes(2));
    expect(transcriptFileReference).toHaveBeenCalledTimes(2);
    expect(resolveTranscriptFiles.mock.calls[1]).toEqual([expect.objectContaining({ references: ["next.md"] })]);
  });

  it("keeps batched hydration working through StrictMode effect cleanup", async () => {
    const resolveTranscriptFiles = vi.fn(async () => ({ files: [{ reference: "notes.md", path: "/owner/notes.md", previewable: true }] }));
    render(<StrictMode><ThreadMarkdown fileViewerContext={context} desktopApi={{ resolveTranscriptFiles, readMarkdownFile: vi.fn() }} text="Read `notes.md`." /></StrictMode>);
    expect(await screen.findByRole("link", { name: "notes.md" })).toBeInTheDocument();
    expect(resolveTranscriptFiles).toHaveBeenCalledTimes(1);
  });
});
