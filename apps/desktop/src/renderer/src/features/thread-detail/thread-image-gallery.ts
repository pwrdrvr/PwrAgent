import type { AppServerThreadEntry, AppServerThreadImagePart } from "@pwragent/shared";

export function collectThreadImageGallery(
  entries: Array<AppServerThreadEntry | undefined>,
): AppServerThreadImagePart[] {
  const images: AppServerThreadImagePart[] = [];
  const seenSourceUrls = new Set<string>();
  const seenUrls = new Set<string>();

  const appendImage = (image: AppServerThreadImagePart): void => {
    if (
      seenUrls.has(image.url)
      || (image.sourceUrl ? seenSourceUrls.has(image.sourceUrl) : false)
    ) {
      return;
    }
    seenUrls.add(image.url);
    if (image.sourceUrl) {
      seenSourceUrls.add(image.sourceUrl);
    }
    images.push(image);
  };

  for (const entry of entries) {
    if (entry?.type === "message") {
      for (const part of entry.parts ?? []) {
        if (part.type === "image") {
          appendImage(part);
        }
      }
      continue;
    }

    if (entry?.type === "activity") {
      for (const detail of entry.details) {
        for (const image of detail.images ?? []) {
          appendImage(image);
        }
      }
    }
  }

  return images;
}

export function threadGalleryImageMatches(
  candidate: AppServerThreadImagePart,
  selected: AppServerThreadImagePart,
): boolean {
  return (
    candidate === selected
    || candidate.url === selected.url
    || Boolean(
      candidate.sourceUrl
      && selected.sourceUrl
      && candidate.sourceUrl === selected.sourceUrl,
    )
  );
}

