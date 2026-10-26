import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  XRAY_BADGE_CLEARANCE_PX,
  XRAY_TARGET_ATTRIBUTE,
  useXraySpyCard,
} from "../xray-spy-card";

/** jsdom has no layout: each element reports the box the test gives it. */
function setRect(element: Element, top: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top }) as DOMRect;
}

/** A 400px lane with 30px rows at 0, 30, 60, … and a row selected. */
function buildList(rows: number, selected: number): HTMLElement[] {
  document.body.innerHTML = `
    <aside class="sidebar"><div class="sidebar__scroll-region"><div class="sidebar-list">
      ${Array.from({ length: rows }, (_, index) =>
        `<div class="thread-row-shell" data-row="${index}"><div class="thread-row${
          index === selected ? " is-selected" : ""
        }"><span class="thread-row__title">Row ${index}</span></div></div>`).join("")}
    </div></div></aside>
    <main class="thread-view"><p class="transcript">Transcript</p></main>`;
  setRect(document.querySelector(".sidebar__scroll-region")!, 0, 400);
  const shells = Array.from(document.querySelectorAll<HTMLElement>(".thread-row-shell"));
  shells.forEach((shell, index) => {
    setRect(shell, index * 30, 30);
    // A lifted card shows every chip: 90px tall, from its slot down.
    setRect(shell.firstElementChild!, index * 30, 90);
  });
  return shells;
}

function pointAt(element: Element): void {
  element.dispatchEvent(new Event("pointermove", { bubbles: true }));
}

const lifted = () =>
  Array.from(document.querySelectorAll<HTMLElement>(`[${XRAY_TARGET_ATTRIBUTE}]`))
    .map((shell) => shell.dataset.row);

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
});

describe("useXraySpyCard", () => {
  it("lifts the selected row when the pointer is not on a row, holding its slot", () => {
    const shells = buildList(6, 2);
    renderHook(() => useXraySpyCard(true));
    expect(lifted()).toEqual(["2"]);
    expect(shells[2]!.style.getPropertyValue("--xray-shell-height")).toBe("30px");
    expect(shells[2]!.style.getPropertyValue("--xray-lift")).toBe("");
  });

  it("lifts the row under the pointer and drops the one before it", () => {
    const shells = buildList(6, 2);
    renderHook(() => useXraySpyCard(true));
    pointAt(shells[4]!.querySelector(".thread-row__title")!);
    expect(lifted()).toEqual(["4"]);
    expect(shells[2]!.style.getPropertyValue("--xray-shell-height")).toBe("");

    // Off the list, back to the selected thread.
    pointAt(document.querySelector(".transcript")!);
    expect(lifted()).toEqual(["2"]);
  });

  it("falls back to the selected row when the pointer leaves the window", () => {
    const shells = buildList(6, 2);
    renderHook(() => useXraySpyCard(true));
    pointAt(shells[4]!.querySelector(".thread-row__title")!);
    expect(lifted()).toEqual(["4"]);
    document.documentElement.dispatchEvent(new Event("pointerleave"));
    expect(lifted()).toEqual(["2"]);
  });

  it("lifts nothing while a row is being dragged", () => {
    const shells = buildList(6, 2);
    shells[0]!.firstElementChild!.classList.add("is-pointer-dragging");
    renderHook(() => useXraySpyCard(true));
    expect(lifted()).toEqual([]);
    pointAt(shells[4]!.querySelector(".thread-row__title")!);
    expect(lifted()).toEqual([]);
  });

  it("lifts nothing when the selected row is out of the lane", () => {
    buildList(20, 15);
    renderHook(() => useXraySpyCard(true));
    expect(lifted()).toEqual([]);
  });

  it("slides a card up just far enough to clear the foot of the lane", () => {
    const shells = buildList(12, 11);
    renderHook(() => useXraySpyCard(true));
    // The card spans 330–420; the lane ends at 400, less the badge.
    expect(lifted()).toEqual(["11"]);
    expect(shells[11]!.style.getPropertyValue("--xray-lift"))
      .toBe(`${420 - (400 - XRAY_BADGE_CLEARANCE_PX)}px`);
  });

  it("puts the row back when X-ray ends", () => {
    const shells = buildList(6, 2);
    const view = renderHook((props: { active: boolean }) => useXraySpyCard(props.active), {
      initialProps: { active: true },
    });
    expect(lifted()).toEqual(["2"]);
    view.rerender({ active: false });
    expect(lifted()).toEqual([]);
    expect(shells[2]!.getAttribute("style")).toBe("");
  });
});
