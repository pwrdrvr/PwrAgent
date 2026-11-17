import type { Editor } from "@tiptap/react";

const KEY = Symbol.for("pwragent.rendererEditorTeardown");

/** The renderer file owns every editor view created in its browser environment. */
class EditorTeardown {
  private readonly editors = new Set<Editor>();
  private readonly installedPrototypes = new WeakSet<Editor>();

  install(EditorClass: typeof Editor): void {
    const prototype = EditorClass.prototype;
    if (this.installedPrototypes.has(prototype)) return;
    this.installedPrototypes.add(prototype);
    // Observe the public mount boundary, including detached editors discarded
    // by StrictMode's initializer replay. DOM queries cannot find those views.
    const mount = Reflect.get(prototype, "mount") as Editor["mount"];
    prototype.mount = new Proxy(mount, {
      apply: (mount, editor: Editor, args) => {
        const result = Reflect.apply(mount, editor, args);
        if (!this.editors.has(editor)) {
          this.editors.add(editor);
          editor.once("destroy", () => this.editors.delete(editor));
        }
        return result;
      },
    });
  }

  dispose(): void {
    // useEditor's cleanup schedules destruction for a later timer turn so a
    // StrictMode remount can reuse the editor. After all file hooks finish,
    // no remount can occur: destroy now, while plugin views still have window.
    // The pending Tiptap timer sees isDestroyed and skips its DOM teardown.
    for (const editor of this.editors) {
      editor.destroy();
      this.editors.delete(editor);
    }
  }
}

type TeardownGlobal = typeof globalThis & { [KEY]?: EditorTeardown };

export function getEditorTeardown(): EditorTeardown {
  return (globalThis as TeardownGlobal)[KEY] ??= new EditorTeardown();
}
