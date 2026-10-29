import {
  findLinearPastedImages,
  type FetchLinearPastedImagesRequest,
  type FetchLinearPastedImagesResponse,
} from "@pwragent/shared";
import {
  composerImageFileFromBase64,
  type ComposerImageFile,
} from "./composer-image-files";

/**
 * Images in text pasted from Linear, for both composers: the main one and
 * the Star Map chat card's. Each composer holds Send while the download
 * runs, drops the result if the draft moved to another thread meanwhile,
 * and shows the notice in its own way.
 */

export type FetchLinearPastedImages = (
  request: FetchLinearPastedImagesRequest,
) => Promise<FetchLinearPastedImagesResponse>;

export type LinearPastedImagesNotice = { title: string; message: string };

export type LinearPastedImagesOutcome = {
  files: ComposerImageFile[];
  /** Time spent decoding the downloaded bytes into files. */
  decodeMs: number;
  notice?: LinearPastedImagesNotice;
};

export const LINEAR_EXPIRED_LINKS_MESSAGE =
  "Linear image links expire five minutes after copying. Connect Linear in Settings → Plugins to attach older ones.";

/** Whether a paste is worth a round trip: it names at least one Linear image. */
export function hasLinearPastedImages(text: string): boolean {
  return findLinearPastedImages(text).length > 0;
}

/** The fetch, with a thrown error read as a failed answer. */
export async function requestLinearPastedImages(
  fetchImages: FetchLinearPastedImages,
  text: string,
): Promise<FetchLinearPastedImagesResponse> {
  try {
    return await fetchImages({ text });
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * What to attach and what to say about an answer, or `undefined` when the
 * setting is off and the paste stays plain text.
 */
export function readLinearPastedImagesResponse(
  response: FetchLinearPastedImagesResponse,
): LinearPastedImagesOutcome | undefined {
  if (response.status === "disabled") return undefined;
  if (response.status === "unavailable") {
    return {
      files: [],
      decodeMs: 0,
      notice: { title: "Linear images not attached", message: LINEAR_EXPIRED_LINKS_MESSAGE },
    };
  }
  if (response.status === "failed") {
    return {
      files: [],
      decodeMs: 0,
      notice: { title: "Linear images not attached", message: response.message },
    };
  }
  const notice = response.failed > 0
    ? {
        title: "Some Linear images not attached",
        message: response.needsConnection
          ? LINEAR_EXPIRED_LINKS_MESSAGE
          : response.failed === 1
            ? "One image could not be downloaded from Linear."
            : `${response.failed} images could not be downloaded from Linear.`,
      }
    : undefined;
  const decodeStart = performance.now();
  const files = response.images.map(composerImageFileFromBase64);
  return {
    files,
    decodeMs: performance.now() - decodeStart,
    ...(notice ? { notice } : {}),
  };
}
