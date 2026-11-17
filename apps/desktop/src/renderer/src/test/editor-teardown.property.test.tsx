import { cleanup, render } from "@testing-library/react";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Plugin } from "prosemirror-state";
import fc from "fast-check";
import { Fragment, StrictMode } from "react";
import { expect, it, TestRunner, vi, type RunnerTestFile } from "vitest";
import ActWarningRunner from "./act-warning-runner";

type Mount = { strict: boolean; replays: number };

async function assertEditorsReleasedAtFileBoundary(mounts: Mount[], file: RunnerTestFile) {
  // The base runner clears the currently executing test and its snapshots.
  // Exercise the real renderer finalizer without clearing this oracle's test.
  const base = vi.spyOn(TestRunner.prototype, "onAfterRunFiles").mockImplementation(() => {});
  const runner = Object.create(ActWarningRunner.prototype) as ActWarningRunner;
  runner.onTaskUpdate = async () => {};
  const editors = new Set<Editor>();
  // Independent oracle: ProseMirror itself tells us when it allocates and
  // destroys a DOM plugin view, including discarded StrictMode editors.
  const liveViews = new Set<object>();
  const probe = Extension.create({
    name: "editorLifetimeOracle",
    addProseMirrorPlugins() {
      editors.add(this.editor);
      return [new Plugin({
        view() {
          const token = {};
          liveViews.add(token);
          return {
            destroy() {
              expect(window.document).toBeDefined();
              liveViews.delete(token);
            },
          };
        },
      })];
    },
  });
  const extensions = [StarterKit, probe];
  function Input() {
    const editor = useEditor({ extensions, content: "<p>draft</p>" });
    return <EditorContent editor={editor} />;
  }
  try {
    for (const { strict, replays } of mounts) {
      const Boundary = strict ? StrictMode : Fragment;
      const view = render(<Boundary><Input /></Boundary>);
      const editable = view.container.querySelector(".ProseMirror");
      for (let replay = 0; replay < replays; replay += 1) {
        view.rerender(<Boundary><Input /></Boundary>);
        expect(view.container.querySelector(".ProseMirror")).toBe(editable);
      }
      view.unmount();
    }
    // No timer/event-loop turn has occurred: React roots are gone, but
    // Tiptap's deferred destruction still owns these real plugin views.
    expect(liveViews.size).toBeGreaterThan(0);
    await runner.onAfterRunFiles([file]);
    expect(liveViews.size).toBe(0);
    await runner.onAfterRunFiles([file]);
    expect(liveViews.size).toBe(0);
  } finally {
    cleanup();
    for (const editor of editors) {
      if (!editor.isDestroyed) editor.destroy();
    }
    base.mockRestore();
  }
}

it("releases a single unmounted editor before the browser environment disappears", async ({ task }) => {
  // The pre-fix property counterexample shrank to this ordinary mount/unmount.
  await assertEditorsReleasedAtFileBoundary([{ strict: false, replays: 0 }], task.file);
});

it("releases every plugin view after generated mount, replay and unmount lifetimes", async ({ task }) => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ strict: fc.boolean(), replays: fc.integer({ min: 0, max: 2 }) }), {
      minLength: 1,
      maxLength: 3,
      size: "max",
    }),
    (mounts) => assertEditorsReleasedAtFileBoundary(mounts, task.file),
  ), {
    numRuns: 20,
    examples: [[[{ strict: true, replays: 2 }]]],
  });
});
