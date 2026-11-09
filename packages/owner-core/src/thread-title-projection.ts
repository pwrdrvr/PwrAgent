import type { AppServerThreadSummary } from "@pwragent/shared";
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
