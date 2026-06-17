import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
