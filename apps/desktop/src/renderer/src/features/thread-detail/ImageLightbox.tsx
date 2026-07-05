import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "../../icons";
import { TranscriptImage } from "./TranscriptImage";

type ImageLightboxProps = {
  /** Image source — a data URL or any resolvable URL. */
  src: string;
  alt: string;
  onClose: () => void;
};

/**
 * The single full-size image viewer used everywhere an image expands —
 * pasted composer attachments and sent transcript images alike. Portaled to
 * `<body>` so it escapes any clipping/stacking ancestor; closes on the scrim,
 * the accent close cookie, or Escape. `TranscriptImage` resolves embedded data
 * URLs to object URLs, so both image sources render the same way.
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image"
      onClick={onClose}
    >
      <div
        className="image-lightbox__content"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          className="image-lightbox__close"
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon size={18} aria-hidden="true" />
        </button>
        <TranscriptImage
          className="image-lightbox__image"
          src={src}
          alt={alt}
        />
      </div>
    </div>,
    document.body,
  );
}
