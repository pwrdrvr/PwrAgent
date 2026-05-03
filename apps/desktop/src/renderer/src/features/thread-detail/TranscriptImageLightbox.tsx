import { useEffect } from "react";
import type { AppServerThreadImagePart } from "@pwragent/shared";
import { TranscriptImage } from "./TranscriptImage";

type TranscriptImageLightboxProps = {
  image: AppServerThreadImagePart;
  onClose: () => void;
};

export function TranscriptImageLightbox(props: TranscriptImageLightboxProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [props.onClose]);

  return (
    <div
      className="transcript-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded transcript image"
      onClick={props.onClose}
    >
      <div
        className="transcript-image-lightbox__content"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          className="button button--ghost transcript-image-lightbox__close"
          onClick={props.onClose}
        >
          Close
        </button>
        <TranscriptImage
          className="transcript-image-lightbox__image"
          src={props.image.url}
          alt={props.image.alt ?? "Expanded transcript image"}
        />
      </div>
    </div>
  );
}
