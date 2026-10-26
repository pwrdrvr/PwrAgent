import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuedRowPositionLabel } from "../QueuedMessageInspector";
import {
  queuedReorderRun,
  type QueuedReorderRow,
  useQueuedRowReorder,
} from "../useQueuedRowReorder";

const ROW_HEIGHT = 32;
const ROW_GAP = 6;

function Band(props: {
  initial: QueuedReorderRow[];
  onMove?: (id: string, toIndex: number) => void;
}) {
  const [rows, setRows] = useState(props.initial);
  const reorder = useQueuedRowReorder({
    rows,
    onMove: (id, toIndex) => {
      props.onMove?.(id, toIndex);
      setRows((current) => {
        const next = current.filter((row) => row.id !== id);
        next.splice(toIndex, 0, current.find((row) => row.id === id)!);
        return next;
      });
    },
  });
  return (
    <>
      <div data-testid="band">
        {rows.map((row, index) => (
          <div
            aria-label={`row ${row.id}`}
            data-queued-reorder-id={row.id}
            key={row.id}
            onKeyDown={(event) => reorder.onKeyDown(event, row.id)}
            onPointerDown={(event) => reorder.onPointerDown(event, row.id)}
          >
            {reorder.canMove(row.id) ? (
              <button data-queued-reorder-grip="" type="button">{`grip ${row.id}`}</button>
            ) : null}
            <button type="button">{`open ${row.id}`}</button>
            <span data-testid={`label-${row.id}`}>
              {row.paused
                ? "Paused"
                : row.group
                ? <QueuedRowPositionLabel reorder={reorder} id={row.id} index={index} />
                : "Held for retry"}
            </span>
          </div>
        ))}
      </div>
      <span data-testid="announcer" ref={reorder.announcerRef} />
    </>
  );
}

const labels = (): string[] =>
  [...screen.getByTestId("band").querySelectorAll("[data-queued-reorder-id]")].map((row) =>
    `${(row as HTMLElement).dataset.queuedReorderId}=${row.querySelector("[data-testid^=label-]")?.textContent}`);

function rowCenter(id: string): number {
  const rows = [...screen.getByTestId("band").querySelectorAll("[data-queued-reorder-id]")];
  const index = rows.findIndex((row) => (row as HTMLElement).dataset.queuedReorderId === id);
  return index * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
}

beforeEach(() => {
  // jsdom has no layout: rows stack at 32px with a 6px gap in a 300px band.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.queuedReorderId;
    if (id === undefined) {
      return { top: 0, left: 0, width: 600, height: 300, bottom: 300, right: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    const top = rowCenter(id) - ROW_HEIGHT / 2;
    return { top, left: 0, width: 600, height: ROW_HEIGHT, bottom: top + ROW_HEIGHT, right: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  // Reduced motion commits a drop at once instead of after the settle.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rows = (...ids: string[]): QueuedReorderRow[] =>
  ids.map((id) => ({ id, title: `Message ${id}`, group: id.startsWith("held") ? undefined : "owner" }));

function drag(id: string, toClientY: number, release: "up" | "cancel" | "escape" = "up"): void {
  const startY = rowCenter(id);
  fireEvent.pointerDown(screen.getByText(`open ${id}`), { button: 0, clientY: startY, pointerId: 7 });
  const steps = 6;
  for (let step = 1; step <= steps; step += 1) {
    fireEvent.pointerMove(window, { clientY: startY + ((toClientY - startY) * step) / steps, pointerId: 7 });
  }
  if (release === "escape") fireEvent.keyDown(window, { key: "Escape" });
  else if (release === "cancel") fireEvent.pointerCancel(window, { pointerId: 7 });
  else fireEvent.pointerUp(window, { clientY: toClientY, pointerId: 7 });
}

describe("queuedReorderRun", () => {
  it("is the contiguous run of the row's own group, and nothing for a fixed row", () => {
    const band = rows("a", "held", "b", "c");
    expect(queuedReorderRun(band, 0)).toEqual([0, 0]);
    expect(queuedReorderRun(band, 1)).toBeUndefined();
    expect(queuedReorderRun(band, 3)).toEqual([2, 3]);
  });
});

describe("useQueuedRowReorder", () => {
  it("renumbers the band while a row is dragged and moves it on release", () => {
    const onMove = vi.fn();
    render(<Band initial={rows("a", "b", "c", "d")} onMove={onMove} />);

    const startY = rowCenter("d");
    fireEvent.pointerDown(screen.getByText("open d"), { button: 0, clientY: startY, pointerId: 7 });
    // Under the activation distance it is still a click.
    fireEvent.pointerMove(window, { clientY: startY - 3, pointerId: 7 });
    expect(screen.getByTestId("band")).not.toHaveClass("is-queued-reordering");
    fireEvent.pointerMove(window, { clientY: rowCenter("a"), pointerId: 7 });

    expect(screen.getByTestId("band")).toHaveClass("is-queued-reordering");
    expect(screen.getByLabelText("row d")).toHaveClass("is-reorder-lifted");
    expect(labels()).toEqual(["a=#2", "b=#3", "c=#4", "d=Next"]);
    // The rows above it slid down one place to open the slot.
    expect(screen.getByLabelText("row a").style.transform).toBe(`translateY(${ROW_HEIGHT + ROW_GAP}px)`);
    expect(screen.getByTestId("band").querySelector(".composer__queued-slot")).toHaveStyle({ top: "0px", height: `${ROW_HEIGHT}px` });

    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(onMove).toHaveBeenCalledWith("d", 0);
    expect(labels()).toEqual(["d=Next", "a=#2", "b=#3", "c=#4"]);
    expect(screen.getByTestId("band")).not.toHaveClass("is-queued-reordering");
    expect(screen.getByTestId("band").querySelector(".composer__queued-slot")).toBeNull();
    expect(screen.getByLabelText("row a").style.transform).toBe("");
  });

  it("numbers only the rows that will send, while dragging past a paused one too", () => {
    const band = rows("a", "b", "c").map((row) => (row.id === "a" ? { ...row, paused: true } : row));
    render(<Band initial={band} />);
    // A paused row takes no place: the row behind it is Next.
    expect(labels()).toEqual(["a=Paused", "b=Next", "c=#2"]);

    fireEvent.pointerDown(screen.getByText("open c"), { button: 0, clientY: rowCenter("c"), pointerId: 7 });
    fireEvent.pointerMove(window, { clientY: rowCenter("a"), pointerId: 7 });
    // Lifted above the paused row, c would send first.
    expect(labels()).toEqual(["a=Paused", "b=#2", "c=Next"]);
    fireEvent.pointerCancel(window, { pointerId: 7 });
  });

  it("stops a lifted row at a row that cannot move", () => {
    const onMove = vi.fn();
    render(<Band initial={rows("held", "a", "b", "c")} onMove={onMove} />);

    drag("c", -200);

    expect(onMove).toHaveBeenCalledWith("c", 1);
    expect(labels()).toEqual(["held=Held for retry", "c=#2", "a=#3", "b=#4"]);
  });

  it("puts every row back on Escape or a cancelled pointer", () => {
    const onMove = vi.fn();
    render(<Band initial={rows("a", "b", "c")} onMove={onMove} />);

    drag("c", rowCenter("a"), "escape");
    drag("c", rowCenter("a"), "cancel");

    expect(onMove).not.toHaveBeenCalled();
    expect(labels()).toEqual(["a=Next", "b=#2", "c=#3"]);
    expect(screen.getByLabelText("row c").style.transform).toBe("");
  });

  it("swallows the click a drag ends on, but not a plain click", () => {
    const onOpen = vi.fn();
    render(<Band initial={rows("a", "b")} />);
    screen.getByTestId("band").addEventListener("click", onOpen);

    drag("b", rowCenter("a"));
    fireEvent.click(screen.getByText("open b"));
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByText("open a"), { button: 0, clientY: rowCenter("a"), pointerId: 8 });
    fireEvent.pointerUp(window, { pointerId: 8 });
    fireEvent.click(screen.getByText("open a"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("moves with the arrow keys on a grip, and with ⌘⇧↑ ↓ anywhere in the row", () => {
    vi.useFakeTimers();
    try {
      const onMove = vi.fn();
      render(<Band initial={rows("held", "a", "b", "c")} onMove={onMove} />);

      const grip = screen.getByRole("button", { name: "grip c" });
      grip.focus();
      fireEvent.keyDown(grip, { key: "ArrowUp" });
      expect(onMove).toHaveBeenLastCalledWith("c", 2);
      expect(labels()).toEqual(["held=Held for retry", "a=#2", "c=#3", "b=#4"]);
      expect(grip).toHaveFocus();
      act(() => { vi.advanceTimersByTime(50); });
      expect(screen.getByTestId("announcer")).toHaveTextContent("Moved “Message c” to position 3 of 4.");

      fireEvent.keyDown(screen.getByText("open c"), { key: "ArrowUp", metaKey: true, shiftKey: true });
      expect(onMove).toHaveBeenLastCalledWith("c", 1);

      // The held row is a wall: no further up.
      fireEvent.keyDown(grip, { key: "ArrowUp" });
      expect(onMove).toHaveBeenCalledTimes(2);
      act(() => { vi.advanceTimersByTime(50); });
      expect(screen.getByTestId("announcer")).toHaveTextContent("Already first of the messages that can move.");

      // A plain arrow off the grip belongs to whatever has focus.
      fireEvent.keyDown(screen.getByText("open c"), { key: "ArrowDown" });
      expect(onMove).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no grip when a row has nowhere to go", () => {
    render(<Band initial={rows("a", "held", "b")} />);
    expect(screen.queryByRole("button", { name: /^grip/ })).toBeNull();
  });
});
