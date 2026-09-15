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

    fireEvent.click(screen.getByRole("dialog", { name: "Expanded image" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the image content is clicked", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox src="https://example.test/cat.png" alt="A cat" onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("img", { name: "A cat" }));
    expect(onClose).not.toHaveBeenCalled();
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

  it("captures click-drag, ignores other pointers, and releases cancelled or lost drags", () => {
    const resize = installResizeObserver();
    const onClose = vi.fn();
    render(<ImageLightbox src="first.png" alt="First" onClose={onClose} />);
    const { viewport, image } = measureImage();
    resize();
    viewport.setPointerCapture = vi.fn();
    viewport.hasPointerCapture = vi.fn(() => true);
    viewport.releasePointerCapture = vi.fn();
    pointer(viewport, "pointerdown", { clientX: 300, clientY: 200 });
    expect(viewport.setPointerCapture).toHaveBeenCalledWith(1);
    pointer(viewport, "pointermove", { pointerId: 2, clientX: 600 });
    expect(image.style.transform).toBe("translate(0px, 0px)");
    pointer(viewport, "pointermove", { clientX: 340, clientY: 250 });
    expect(image.style.transform).toBe("translate(40px, 50px)");
    pointer(viewport, "pointercancel", {});
    pointer(viewport, "pointermove", { clientX: 500 });
    expect(image.style.transform).toBe("translate(40px, 50px)");
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer(viewport, "pointerdown", {});
    pointer(viewport, "pointermove", { buttons: 0, clientX: 100 });
    expect(viewport).toHaveAttribute("data-panning", "false");
    pointer(viewport, "pointerdown", {});
    pointer(viewport, "lostpointercapture", {});
    expect(viewport).toHaveAttribute("data-panning", "false");
    pointer(viewport, "pointerdown", {});
    fireEvent(window, new Event("blur"));
    expect(viewport).toHaveAttribute("data-panning", "false");
    fireEvent.click(viewport);
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
