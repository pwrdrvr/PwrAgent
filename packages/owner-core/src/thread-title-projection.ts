import type { AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import type { OwnerThreadMetadata } from "./thread-storage";

/** A confirmed native name fences provenance against later provider renames.
 * Older imported titles have no acknowledgement and remain pending owner facts. */
export function projectOwnerThreadTitle(
  native: Pick<AppServerThreadSummary, "title" | "titleSource">,
  metadata: OwnerThreadMetadata | undefined,
): Pick<AppServerThreadSummary, "title" | "titleSource"> {
  const title = metadata?.title;
  if (!title || title.source === "fallback"
    || (title.nativeName !== undefined && title.nativeName !== native.title)) return native;
  return { title: title.text, titleSource: title.source };
}

/** Listing overlays already contain owner title facts without transcript histories. */
export function projectOverlayThreadTitle(
  native: Pick<AppServerThreadSummary, "title" | "titleSource">,
  overlay: Pick<ThreadOverlayState, "title" | "titleSource" | "titleNativeName"> | undefined,
): Pick<AppServerThreadSummary, "title" | "titleSource"> {
  return projectOwnerThreadTitle(native, {
    title: overlay?.title === undefined ? undefined : {
      text: overlay.title,
      source: overlay.titleSource ?? "fallback",
      ...(overlay.titleNativeName !== undefined ? { nativeName: overlay.titleNativeName } : {}),
    },
  });
}
