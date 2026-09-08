import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { materializeNavigationThreads, type AppServerThreadSummary, type LinkedDirectorySummary, type NavigationThreadSummary } from "@pwragent/shared";
import { ThreadMetaChips } from "../ThreadMetaChips";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([false, true])("merges attachment metadata before rendering unique directory chips (remote=%s)", (remote) => {
  const directory: LinkedDirectorySummary = { id: "/worktrees/task/repo", path: "/repos/repo", label: "repo", kind: "local" };
  const attachment: LinkedDirectorySummary = { ...directory, kind: "worktree", worktreePath: directory.id };
  const other: LinkedDirectorySummary = { ...attachment, id: "/worktrees/other/repo", worktreePath: "/worktrees/other/repo", label: "other" };
  const provider: AppServerThreadSummary = { id: "attachment-thread", source: "codex", title: "Attachment", titleSource: "explicit",
    linkedDirectories: [directory, other] };
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const materialize = (attached: boolean): NavigationThreadSummary => {
    const thread = materializeNavigationThreads({ firstSnapshot: false, previousKnownThreadKeys: [], threads: [provider],
      overlayByThreadKey: { "codex:attachment-thread": { backend: "codex", threadId: provider.id, executionMode: "default",
        extraLinkedDirectories: attached ? [attachment] : [] } } })[0]!;
    // Federation transports this owner materialization without a second merge.
    return remote ? { ...(JSON.parse(JSON.stringify(thread)) as NavigationThreadSummary), federation: { ref: { backend: "codex", threadId: provider.id,
      target: { scope: "remote", instanceId: "fixture-owner" } }, instanceLabel: "Owner" } } : thread;
  };
  const view = render(<ThreadMetaChips thread={materialize(false)} includeLinkedDirectories />);
  view.rerender(<ThreadMetaChips thread={materialize(true)} includeLinkedDirectories />);
  expect(view.container.querySelectorAll(".path-copy-target")).toHaveLength(2);
  expect(materialize(true).linkedDirectories).toEqual([attachment, other]);
  view.rerender(<ThreadMetaChips thread={materialize(true)} includeLinkedDirectories />);
  expect(error.mock.calls.filter((args) => args.some((arg) => String(arg).includes("same key")))).toEqual([]);
});
