/**
 * Scrolls the sidebar's selected thread row toward the middle of the list,
 * for the thread title click and the jump palette.
 */
const SELECTED_ROW = ".sidebar .thread-row.is-selected";

export function revealSelectedSidebarThreadRow(options?: { instant?: boolean }): void {
  const row = document.querySelector<HTMLElement>(SELECTED_ROW);
  if (!row) {
    return;
  }
  row.scrollIntoView({
    behavior: options?.instant === true ? "auto" : "smooth",
    block: "center",
    inline: "nearest",
  });
}
