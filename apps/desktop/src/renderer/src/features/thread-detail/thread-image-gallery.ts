import { transcriptImageUnavailableReason } from "@pwragent/shared/transcript-image-sources";
import type {
  AppServerThreadEntry,
  AppServerThreadImagePart,
} from "@pwragent/shared/contracts/normalized-app-server";

export function collectThreadImageGallery(
  entries: Array<AppServerThreadEntry | undefined>,
): AppServerThreadImagePart[] {
  const images: AppServerThreadImagePart[] = [];
  const seenUrls = new Set<string>();

  const appendImage = (image: AppServerThreadImagePart): void => {
    // One source path can point to several independently retained images.
    if (transcriptImageUnavailableReason(image) || seenUrls.has(image.url)) {
      return;
    }
    seenUrls.add(image.url);
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
  return candidate.url === selected.url;
}
