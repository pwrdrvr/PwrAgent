import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "../ImageLightbox";

afterEach(() => {
  cleanup();
});

describe("ImageLightbox", () => {
  it("renders the image into a labeled dialog portaled to the body", () => {
    render(
      <ImageLightbox
        src="https://example.test/cat.png"
        alt="A cat"
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    expect(dialog).toBeInTheDocument();
    // Portaled out of the React root straight to <body> so it escapes any
    // clipping/stacking ancestor.
    expect(dialog.parentElement).toBe(document.body);

    const image = screen.getByRole("img", { name: "A cat" });
    expect(image).toHaveAttribute("src", "https://example.test/cat.png");
  });

  it("closes via the accent cookie button", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop scrim is clicked", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    pressAndClick(screen.getByRole("dialog", { name: "Expanded image" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the empty letterbox beside the image is clicked", () => {
    // The viewport spans the window minus the chrome bands, so most of what
    // reads as scrim is inside it. It used to take that press as the start of
    // a pan and dismiss nothing at all.
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    pressAndClick(screen.getByLabelText("Image pan and zoom"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the image content is clicked", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    pressAndClick(stubPointerCapture(screen.getByRole("img", { name: "A cat" })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close when a press on the scrim travels before release", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    pointer(dialog, "pointerdown", { clientX: 40, clientY: 40 });
    fireEvent.click(dialog, { clientX: 220, clientY: 40 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not let a stale scrim press dismiss a later click on the image", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    const image = stubPointerCapture(screen.getByRole("img", { name: "A cat" }));
    // A cancelled press leaves its record behind: no click ever cleared it.
    pointer(dialog, "pointerdown", { clientX: 200, clientY: 200 });
    fireEvent(dialog, new Event("pointercancel", { bubbles: true }));
    // The image stops the next press from reaching the dialog's bubble
    // handler — the gesture needs that — so only a capture-phase record can
    // overwrite the stale one before the click arrives.
    pressAndClick(image, { clientX: 200, clientY: 200 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close when a toolbar control is used", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    pressAndClick(screen.getByRole("button", { name: "Zoom in" }));
    pressAndClick(screen.getByRole("button", { name: "Copy image" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("explains every glyph-only control on hover, including a greyed-out one", () => {
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" position={1} total={2}
        onClose={() => {}} onNext={() => {}} />,
    );

    // A native `title` is not enough here: `.image-lightbox` is
    // `overflow: hidden`, which clips a CSS pseudo-element tooltip, and every
    // control in the pill is an unlabelled glyph.
    for (const [name, hint] of [
      ["Zoom out", "Zoom out"],
      ["Zoom in", "Zoom in"],
      ["Fit to window", "Fit the whole image in the window"],
      ["Copy image", "Copy image"],
      ["Close", "Close (Esc)"],
      ["Next image", "Next image (Right Arrow)"],
    ] as const) {
      const control = screen.getByRole("button", { name });
      fireEvent.mouseEnter(control);
      expect(document.body.querySelector(".viewport-tooltip"), name).toHaveTextContent(hint);
      fireEvent.mouseLeave(control);
      expect(document.body.querySelector(".viewport-tooltip")).toBeNull();
    }

    // Nothing in the pill is `disabled`, because a disabled button fires no
    // pointer events and so could never raise the tooltip an operator hovers a
    // greyed-out glyph to read.
    const fit = screen.getByRole("button", { name: "Fit to window" });
    expect(fit).toHaveAttribute("aria-disabled", "true");
    expect(fit).toBeEnabled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates galleries with edge controls and the Left/Right Arrow keys", () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    render(
      <ImageLightbox
        src="https://example.test/cat.png"
        alt="A cat"
        position={2}
        total={3}
        onClose={() => {}}
        onNext={onNext}
        onPrevious={onPrevious}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    expect(dialog).toHaveTextContent("2 / 3");
    // Widens the side band in `app.css` so an edge control has somewhere to
    // stand that the fitted image does not already occupy.
    expect(dialog).toHaveAttribute("data-gallery", "true");

    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(onPrevious).toHaveBeenCalledTimes(2);
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it("shows disabled gallery controls at the first and last image", () => {
    const { rerender } = render(
      <ImageLightbox
        src="https://example.test/first.png"
        alt="First"
        position={1}
        total={2}
        onClose={() => {}}
        onNext={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Previous image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next image" })).toBeEnabled();

    rerender(
      <ImageLightbox
        src="https://example.test/last.png"
        alt="Last"
        position={2}
        total={2}
        onClose={() => {}}
        onPrevious={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Previous image" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled();
  });

  it("stops listening for Escape after unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

function measureImage() {
  const viewport = screen.getByLabelText("Image pan and zoom");
  const image = screen.getByRole("img");
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, width: 800, height: 600 } as DOMRect);
  Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } });
  fireEvent.load(image);
  return { viewport, image };
}

// ResizeObserver delivers real layout sizes before interaction in the browser.
function installResizeObserver() {
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  return () => act(() => resize());
}

/** jsdom implements no pointer capture; Electron does. */
function stubPointerCapture(element: HTMLElement) {
  element.setPointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn(() => true);
  element.releasePointerCapture = vi.fn();
  return element;
}

/**
 * A dismiss is a press followed by a click, and the dialog reads both — it has
 * to, or a pan released over the scrim would close the lightbox. A bare
 * `fireEvent.click` describes nothing an operator can actually do.
 */
function pressAndClick(target: HTMLElement, at = { clientX: 120, clientY: 120 }) {
  pointer(target, "pointerdown", at);
  fireEvent.click(target, at);
}

function pointer(target: HTMLElement, type: string, fields: Record<string, number>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, button: 0, buttons: 1, clientX: 0, clientY: 0 }, fields);
  fireEvent(target, event);
}

describe("shared lightbox gestures", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("anchors pinch at the cursor, pans both axes, and resets on fit and gallery changes", () => {
    const resize = installResizeObserver();
    const view = render(<ImageLightbox src="first.png" alt="First" onClose={() => {}} />);
    const { viewport, image } = measureImage();
    resize();
    expect(image.style.width).toBe("800px");
    const pinch = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true,
      deltaY: -Math.log(2) / Math.log(1.0025), clientX: 700, clientY: 450 });
    fireEvent(viewport, pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(parseFloat(image.style.width)).toBeCloseTo(1600);
    expect(image.style.transform).toBe("translate(-200px, -100px)");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 30, deltaY: -40 });
    fireEvent(viewport, wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(image.style.transform).toBe("translate(-230px, -60px)");
    fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
    expect(image.style.width).toBe("800px");
    expect(image.style.transform).toBe("translate(0px, 0px)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    view.rerender(<ImageLightbox src="second.png" alt="Second" onClose={() => {}} />);
    measureImage();
    resize();
    expect(screen.getByRole("img").style.width).toBe("800px");
  });

  it("pans with focused viewport arrows while preserving gallery navigation and Escape", () => {
    const resize = installResizeObserver();
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const onClose = vi.fn();
    render(<ImageLightbox src="first.png" alt="First" onClose={onClose}
      onPrevious={onPrevious} onNext={onNext} position={2} total={3} />);
    const { viewport, image } = measureImage();
    resize();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    viewport.focus();
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(image.style.transform).toBe("translate(-40px, -40px)");
    fireEvent.keyDown(viewport, { key: "ArrowLeft" });
    fireEvent.keyDown(viewport, { key: "ArrowUp" });
    expect(image.style.transform).toBe("translate(0px, 0px)");
    for (let index = 0; index < 50; index++) fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(image.style.transform).toBe("translate(-936px, 0px)");
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    screen.getByRole("button", { name: "Fit to window" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("uses cumulative native gesture scales once and bounds zoom and pan", () => {
    const resize = installResizeObserver();
    render(<ImageLightbox src="first.png" alt="First" onClose={() => {}} />);
    const { viewport, image } = measureImage();
    resize();
    const gesture = (type: string, scale: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { scale, clientX: 500, clientY: 350 });
      fireEvent(viewport, event);
      expect(event.defaultPrevented).toBe(true);
    };
    gesture("gesturestart", 1);
    gesture("gesturechange", 2);
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -200 });
    expect(image.style.width).toBe("1600px");
    gesture("gesturechange", 3);
    expect(image.style.width).toBe("2400px");
    gesture("gestureend", 3);
    fireEvent.wheel(viewport, { metaKey: true, deltaY: -10000, clientX: 500, clientY: 350 });
    expect(image.style.width).toBe("6400px");
    fireEvent.wheel(viewport, { deltaX: 100000, deltaY: 100000 });
    expect(image.style.transform).toBe("translate(-3536px, -2636px)");
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: 10000, clientX: 500, clientY: 350 });
    expect(image.style.width).toBe("80px");
  });

  it("captures click-drag on the image, ignores other pointers, and releases cancelled or lost drags", () => {
    const resize = installResizeObserver();
    const onClose = vi.fn();
    render(<ImageLightbox src="first.png" alt="First" onClose={onClose} />);
    const { viewport, image } = measureImage();
    resize();
    stubPointerCapture(image);
    // A press on the box AROUND the image starts nothing: that surface is
    // scrim, and it dismisses.
    pointer(viewport, "pointerdown", { clientX: 300, clientY: 200 });
    expect(image.setPointerCapture).not.toHaveBeenCalled();
    pointer(image, "pointerdown", { clientX: 300, clientY: 200 });
    expect(image.setPointerCapture).toHaveBeenCalledWith(1);
    pointer(image, "pointermove", { pointerId: 2, clientX: 600 });
    expect(image.style.transform).toBe("translate(0px, 0px)");
    pointer(image, "pointermove", { clientX: 340, clientY: 250 });
    expect(image.style.transform).toBe("translate(40px, 50px)");
    pointer(image, "pointercancel", {});
    pointer(image, "pointermove", { clientX: 500 });
    expect(image.style.transform).toBe("translate(40px, 50px)");
    expect(image.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer(image, "pointerdown", {});
    pointer(image, "pointermove", { buttons: 0, clientX: 100 });
    expect(image).toHaveAttribute("data-panning", "false");
    pointer(image, "pointerdown", {});
    pointer(image, "lostpointercapture", {});
    expect(image).toHaveAttribute("data-panning", "false");
    pointer(image, "pointerdown", {});
    fireEvent(window, new Event("blur"));
    expect(image).toHaveAttribute("data-panning", "false");
    pressAndClick(image);
    expect(onClose).not.toHaveBeenCalled();
    expect(image).toHaveAttribute("draggable", "false");
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    fireEvent(image, context);
    expect(context.defaultPrevented).toBe(false);
  });

  it("owns wheel propagation, restores focus and document scrolling on close", () => {
    const resize = installResizeObserver();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    document.body.style.overflow = "auto";
    const outerWheel = vi.fn();
    const view = render(<div onWheel={outerWheel}><ImageLightbox src="first.png" alt="First" onClose={() => {}} /></div>);
    measureImage();
    resize();
    fireEvent.wheel(screen.getByLabelText("Image pan and zoom"), { deltaY: 20 });
    expect(outerWheel).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe("auto");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
