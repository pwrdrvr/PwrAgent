import { describe, expect, it } from "vitest";
import {
  THREAD_TODO_ITEM_TEXT_MAX_LENGTH,
  THREAD_TODO_MAX_ITEMS,
  THREAD_TODO_ORIGIN_ID_MAX_LENGTH,
  THREAD_TODO_TITLE_MAX_LENGTH,
  mergeThreadTodoItems,
  parseThreadTodoItemTexts,
  threadTodoBlockingItems,
  threadTodoItemNoun,
  threadTodoItemProgress,
  threadTodoMessageOriginFromUnknown,
  threadTodoOpenItems,
  type ThreadTodoItem,
} from "../thread-todos";

function counter(prefix = "new"): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

describe("parseThreadTodoItemTexts", () => {
  it("trims each step and keeps the order", () => {
    expect(parseThreadTodoItemTexts([" Run the tests ", "Update the docs"])).toEqual({
      ok: true,
      value: ["Run the tests", "Update the docs"],
    });
    expect(parseThreadTodoItemTexts([])).toEqual({ ok: true, value: [] });
  });

  it("refuses a non-array, a blank or non-string step, and anything past the limits", () => {
    expect(parseThreadTodoItemTexts("Run the tests")).toMatchObject({ ok: false });
    expect(parseThreadTodoItemTexts(["Tests", "  "])).toEqual({
      ok: false,
      message: "items[1] must be a non-empty string.",
    });
    expect(parseThreadTodoItemTexts([42], "add_todo items")).toEqual({
      ok: false,
      message: "add_todo items[0] must be a non-empty string.",
    });
    expect(parseThreadTodoItemTexts(["x".repeat(THREAD_TODO_ITEM_TEXT_MAX_LENGTH)]))
      .toMatchObject({ ok: true });
    expect(parseThreadTodoItemTexts(["x".repeat(THREAD_TODO_ITEM_TEXT_MAX_LENGTH + 1)]))
      .toMatchObject({ ok: false });
    const full = Array.from({ length: THREAD_TODO_MAX_ITEMS }, (_, index) => `Step ${index}`);
    expect(parseThreadTodoItemTexts(full)).toMatchObject({ ok: true });
    expect(parseThreadTodoItemTexts([...full, "One more"])).toMatchObject({ ok: false });
  });
});

describe("mergeThreadTodoItems", () => {
  const existing: ThreadTodoItem[] = [
    { id: "a", text: "Tests", checked: true },
    { id: "b", text: "Docs", checked: false },
    { id: "c", text: "Notes", checked: true },
  ];

  it("mints an id for every step of a new list, all unchecked", () => {
    expect(mergeThreadTodoItems(undefined, ["One", "Two"], counter())).toEqual([
      { id: "new-1", text: "One", checked: false },
      { id: "new-2", text: "Two", checked: false },
    ]);
  });

  it("keeps an unchanged step's id and tick, in the restated order", () => {
    expect(mergeThreadTodoItems(existing, ["Notes", "Tests", "Screenshots"], counter())).toEqual([
      { id: "c", text: "Notes", checked: true },
      { id: "a", text: "Tests", checked: true },
      { id: "new-1", text: "Screenshots", checked: false },
    ]);
  });

  it("treats an edited text as a new step and matches each old step once", () => {
    const merged = mergeThreadTodoItems(
      [{ id: "a", text: "Tests", checked: true }],
      ["Tests", "Tests", "tests"],
      counter(),
    );
    expect(merged).toEqual([
      { id: "a", text: "Tests", checked: true },
      { id: "new-1", text: "Tests", checked: false },
      { id: "new-2", text: "tests", checked: false },
    ]);
  });
});

describe("checklist progress", () => {
  it("counts checked steps and lists the open ones", () => {
    expect(threadTodoItemProgress({ items: [] })).toBeUndefined();
    expect(threadTodoItemProgress({})).toBeUndefined();
    expect(threadTodoItemProgress({ items: [
      { id: "a", text: "Tests", checked: true },
      { id: "b", text: "Docs", checked: false },
    ] })).toEqual({ checked: 1, total: 2, noun: "steps" });
    expect(threadTodoOpenItems({ items: [
      { id: "a", text: "Tests", checked: true },
      { id: "b", text: "Docs", checked: false },
    ] })).toEqual([{ id: "b", text: "Docs", checked: false }]);
  });
});

describe("prerequisites", () => {
  const items: ThreadTodoItem[] = [
    { id: "p", text: "Clone", checked: false, prerequisite: true },
    { id: "a", text: "Implement", checked: false },
    { id: "b", text: "Test", checked: true },
  ];

  it("merge apart from the steps and come first", () => {
    expect(mergeThreadTodoItems(undefined, ["Implement"], counter(), ["Clone"])).toEqual([
      { id: "new-1", text: "Clone", checked: false, prerequisite: true },
      { id: "new-2", text: "Implement", checked: false },
    ]);
    // A list left undefined keeps that kind as it is.
    expect(mergeThreadTodoItems(items, undefined, counter(), ["Clone", "Sign in"])).toEqual([
      items[0],
      { id: "new-1", text: "Sign in", checked: false, prerequisite: true },
      items[1],
      items[2],
    ]);
    expect(mergeThreadTodoItems(items, ["Test"], counter())).toEqual([items[0], items[2]]);
  });

  it("block a handoff alone, and are what a handoff's progress counts", () => {
    const handoff = { items, action: { type: "start_thread" as const, prompt: "Go" } };
    expect(threadTodoBlockingItems(handoff)).toEqual([items[0]]);
    expect(threadTodoBlockingItems({ items })).toEqual([items[0], items[1]]);
    expect(threadTodoBlockingItems({ ...handoff, items: items.slice(1) })).toEqual([]);
    // Any other card counts its steps and leaves prerequisites out.
    expect(threadTodoItemProgress({ items })).toEqual({ checked: 1, total: 2, noun: "steps" });
    expect(threadTodoItemProgress({ items: [items[0]!] })).toBeUndefined();
    // A handoff's steps are the new thread's plan, which nothing ticks.
    expect(threadTodoItemProgress(handoff)).toEqual({ checked: 0, total: 1, noun: "prerequisites" });
    expect(threadTodoItemProgress({ ...handoff, items: items.slice(1) })).toBeUndefined();
    expect(threadTodoItemNoun([items[0]!])).toBe("prerequisite");
    expect(threadTodoItemNoun([items[0]!, items[0]!])).toBe("prerequisites");
    expect(threadTodoItemNoun([items[0]!, items[1]!])).toBe("steps");
    expect(threadTodoItemNoun([items[1]!])).toBe("step");
  });
});

describe("threadTodoMessageOriginFromUnknown", () => {
  it("reads a card id and its trimmed title", () => {
    expect(threadTodoMessageOriginFromUnknown({ id: " todo-1 ", title: "  Fix flaky sync test " }))
      .toEqual({ id: "todo-1", title: "Fix flaky sync test" });
    expect(threadTodoMessageOriginFromUnknown({ id: "todo-1" })).toEqual({ id: "todo-1" });
  });

  it("is no marker without a usable id", () => {
    for (const value of [
      undefined, null, "todo-1", ["todo-1"], {}, { id: "" }, { id: "   " }, { id: 7 },
      { id: "x".repeat(THREAD_TODO_ORIGIN_ID_MAX_LENGTH + 1) },
    ]) {
      expect(threadTodoMessageOriginFromUnknown(value)).toBeUndefined();
    }
    expect(threadTodoMessageOriginFromUnknown({ id: "x".repeat(THREAD_TODO_ORIGIN_ID_MAX_LENGTH) }))
      .toEqual({ id: "x".repeat(THREAD_TODO_ORIGIN_ID_MAX_LENGTH) });
  });

  it("drops a title that is not text or is blank, and cuts a long one", () => {
    expect(threadTodoMessageOriginFromUnknown({ id: "todo-1", title: { text: "Fix" } })).toEqual({ id: "todo-1" });
    expect(threadTodoMessageOriginFromUnknown({ id: "todo-1", title: "   " })).toEqual({ id: "todo-1" });
    expect(threadTodoMessageOriginFromUnknown({ id: "todo-1", title: "t".repeat(400) })?.title)
      .toBe("t".repeat(THREAD_TODO_TITLE_MAX_LENGTH));
  });
});
