import { useSyncExternalStore } from "react";
import { ImageLightbox } from "./ImageLightbox";

/** One image in a gallery, as the lightbox shows it. */
export type ImageGalleryItem = {
  src: string;
  alt: string;
  dialogLabel?: string;
};

type ImageGallery = {
  items: readonly ImageGalleryItem[];
  index: number;
  /** Where focus goes on close when the control that opened it is gone. */
  onFallbackFocus?: () => void;
};

let gallery: ImageGallery | undefined;
const listeners = new Set<() => void>();

function publish(next: ImageGallery | undefined): void {
  gallery = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readGallery(): ImageGallery | undefined {
  return gallery;
}

/**
 * Opens the window's image lightbox on `items[index]`.
 *
 * The gallery keeps its own copy of the list, so nothing the caller renders
 * has to stay mounted. A queued message's thumbnails open it, and the message
 * can then be sent, edited, or deleted, or its launchpad can become a thread,
 * while the operator is still paging through the images: the row that opened
 * the lightbox is gone, and the lightbox is not.
 */
export function openImageGallery(request: ImageGallery): void {
  if (request.items.length === 0) {
    return;
  }
  publish({
    items: request.items.map((item) => ({ ...item })),
    index: Math.min(Math.max(request.index, 0), request.items.length - 1),
    ...(request.onFallbackFocus ? { onFallbackFocus: request.onFallbackFocus } : {}),
  });
}

/**
 * Draws the gallery `openImageGallery` opened. Mounted once per window, beside
 * the tooltip layer, so it outlives every surface that can open it.
 */
export function ImageGalleryLayer() {
  const current = useSyncExternalStore(subscribe, readGallery, readGallery);
  if (!current) {
    return null;
  }
  const item = current.items[current.index]!;
  const show = (index: number) => publish({ ...current, index });
  return (
    <ImageLightbox
      src={item.src}
      alt={item.alt}
      dialogLabel={item.dialogLabel}
      position={current.index + 1}
      total={current.items.length}
      onClose={() => {
        publish(undefined);
        // The lightbox returns focus to its opener while the opener is still
        // in the document. When it is not, focus is left on <body>, and the
        // caller's fallback (the composer input) takes it.
        requestAnimationFrame(() => {
          if (document.activeElement === null || document.activeElement === document.body) {
            current.onFallbackFocus?.();
          }
        });
      }}
      onPrevious={current.index > 0 ? () => show(current.index - 1) : undefined}
      onNext={
        current.index < current.items.length - 1
          ? () => show(current.index + 1)
          : undefined
      }
    />
  );
}
