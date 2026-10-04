import { createContext, useContext } from "react";
import { formatFileSize } from "../../../lib/format-bytes";
import {
  formatExtent,
  resolvedSides,
  type ImageDiffEntry,
  type ImageDiffItem,
  type ImageSideKey,
} from "./image-diff-model";
import {
  sideResolution,
  useImageSide,
  type ImagePreviewStore,
  type ImageSideState,
} from "./image-preview-store";

/** What the Edits panel hands its image rows: the shared previews, and the
 *  way into the lightbox at a given file and item. */
export type ImageDiffController = {
  store: ImagePreviewStore;
  /** Bumped when the working tree may have changed under the previews. */
  generation: number;
  open: (entryKey: string, item: ImageDiffItem) => void;
};

/** At or under this the frame enlarges the picture, and pixel art should
 *  enlarge as pixels rather than blur. */
const SMALL_IMAGE_EDGE = 128;

export const ImageDiffContext = createContext<ImageDiffController | undefined>(undefined);

export function useImageDiffController(): ImageDiffController | undefined {
  return useContext(ImageDiffContext);
}

/** What a side that produced no picture says instead. */
export function sideNote(state: ImageSideState): string {
  switch (state.kind) {
    case "loading":
      return "Loading…";
    case "missing":
      return "Not in this revision";
    case "tooLarge":
      return `Too large to preview (${formatFileSize(state.sizeBytes)})`;
    case "lfsPointer":
      return "Git LFS pointer";
    case "unavailable":
      return "Couldn’t read the image";
    default:
      return "";
  }
}

export function sideLabel(side: ImageSideKey, sides: readonly ImageSideKey[]): string {
  if (sides.length === 2) {
    return side === "before" ? "Before" : "After";
  }
  return side === "before" ? "Deleted" : "Added";
}

/**
 * The expanded image row: Before and After as a pair of small frames, each of
 * which opens the lightbox on itself. The rail is far too narrow to compare
 * anything in — the frames are there to say which picture this is and that it
 * changed, and to be the door into the viewer that can actually compare.
 */
export function ImageDiffPreview({ entry }: { entry: ImageDiffEntry }) {
  const controller = useImageDiffController();
  const wantsBefore = !entry.sides || entry.sides.includes("before");
  const wantsAfter = !entry.sides || entry.sides.includes("after");
  const before = useImageSide({
    store: controller?.store,
    entry,
    side: "before",
    enabled: wantsBefore,
    generation: controller?.generation ?? 0,
  });
  const after = useImageSide({
    store: controller?.store,
    entry,
    side: "after",
    enabled: wantsAfter,
    generation: controller?.generation ?? 0,
  });
  if (!controller) {
    return null;
  }
  const states = { before, after };
  const sides = resolvedSides(entry, (side) => sideResolution(states[side]));

  return (
    <div className="image-diff-preview" data-sides={sides.length}>
      {sides.map((side) => {
        const state = states[side];
        const label = sideLabel(side, sides);
        const meta = state.kind === "image"
          ? [state.extent ? formatExtent(state.extent) : undefined, formatFileSize(state.bytes)]
            .filter(Boolean)
            .join(" · ")
          : sideNote(state);
        return (
          <button
            type="button"
            key={side}
            className="image-diff-preview__side"
            aria-label={`Open ${label.toLowerCase()} of ${entry.repoPath}`}
            onClick={() => controller.open(entry.key, side)}
          >
            <span className="image-diff-preview__frame" data-state={state.kind}
              data-small={state.kind === "image" && state.extent
                ? Math.max(state.extent.w, state.extent.h) <= SMALL_IMAGE_EDGE
                : undefined}>
              {state.kind === "image" ? (
                <img src={state.url} alt="" draggable={false} />
              ) : null}
            </span>
            <span className="image-diff-preview__caption">
              <span className="image-diff-preview__label">{label}</span>
              <span className="image-diff-preview__meta">{meta}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
