import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptReadingAnchor } from "../transcript-reading-anchor";

type Box = { top: number; height: number };

function fixture() {
  const scroller = document.createElement("div");
  document.body.append(scroller);
  const viewportHeight = 200;
  let contentHeight = 1_100;
  let scrollTop = 0;
  Object.defineProperties(scroller, {
    clientHeight: { value: viewportHeight },
    scrollHeight: { get: () => contentHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (top: number) => {
        scrollTop = Math.max(0, Math.min(top, contentHeight - viewportHeight));
      },
    },
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, viewportHeight);

  const rowIds: string[] = [];
  const anchor = createTranscriptReadingAnchor();
  return {
    scroller,
    anchor,
    capture(top: number) {
      scroller.scrollTop = top;
      anchor.capture(scroller, rowIds, true);
    },
    resize(height: number) {
      contentHeight = height;
      scroller.scrollTop = scrollTop;
    },
    row(...children: Element[]) {
      const row = document.createElement("div");
      row.id = `reading-row-${rowIds.length}`;
      row.className = "transcript-list__item";
      row.append(...children);
      scroller.append(row);
      rowIds.push(row.id);
    },
    box(tag: string, layout: Box) {
      const element = document.createElement(tag);
      element.getBoundingClientRect = () =>
        new DOMRect(0, layout.top - scrollTop, 160, layout.height);
      return element;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("transcript reading anchor", () => {
  it("stays on a continuation when a later block of the same message grows", () => {
    const view = fixture();
    const image = { top: 400, height: 70 };
    const following = { top: 490, height: 80 };
    view.row(
      view.box("article", { top: 100, height: 120 }),
      view.box("article", { top: 250, height: 140 }),
      view.box("article", image),
    );
    view.row(view.box("article", following));
    view.capture(300);

    image.height += 90;
    following.top += 90;
    view.anchor.restore(view.scroller);

    expect(view.scroller.scrollTop).toBe(300);
  });

  it("stays on a tall image when a shorter preview on its line grows", () => {
    const view = fixture();
    const short = { top: 250, height: 28 };
    const nextLine = { top: 380, height: 100 };
    const body = view.box("aside", { top: 190, height: 300 });
    const gallery = document.createElement("div");
    gallery.className = "transcript-work-phase-group__images";
    gallery.append(
      view.box("button", { top: 250, height: 120 }),
      view.box("button", short),
      view.box("button", nextLine),
    );
    body.append(gallery);
    view.row(body);
    view.capture(300);

    short.height = 175;
    nextLine.top += 55;
    view.anchor.restore(view.scroller);

    expect(view.scroller.scrollTop).toBe(300);
  });

  it("restores from the reader's position before the browser clamped it", () => {
    const view = fixture();
    const content = { top: 720, height: 100 };
    view.row(view.box("article", content));
    view.capture(700);

    content.top -= 250;
    view.resize(800);
    expect(view.scroller.scrollTop).toBe(600);
    view.anchor.restore(view.scroller);
    expect(view.scroller.scrollTop).toBe(450);
  });
});
