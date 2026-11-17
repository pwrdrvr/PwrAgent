import type { Page } from "@playwright/test";

/**
 * Layout rules for the open archive group confirmation, checked in the
 * page's real layout. jsdom performs no layout, so the vitest contract
 * (`archive-group-dialog-layout-contract.test.ts`) can only pin the
 * declarations; these rules hold whatever declarations produce them.
 *
 * - R1: Cancel and Archive can each be scrolled fully into view and then
 *   receive a click at their centre.
 * - R2: the heading does not open above the top edge.
 * - R3: when the dialog's chrome, a 40px list peek and the backdrop's
 *   padding fit in the viewport, both buttons are in view on open.
 * - R4: a list that overflows is framed, and shaded by scroll-attached
 *   layers that local layers cover at each end.
 * - R5: the list keeps a 40px peek, or all of its rows when they are fewer.
 *
 * Each rule is stated about what the operator sees, so a fix that holds
 * them some other way still passes. Call it with the dialog freshly
 * opened, or with every scroll offset in it back at zero.
 */
export const ARCHIVE_GROUP_LIST_PEEK_PX = 40;

export async function archiveGroupDialogLayoutViolations(page: Page): Promise<string[]> {
  const dialog = page.getByRole("dialog", { name: /^Archive \d+ Threads?\?$/ });
  const measured = await dialog.evaluate((element: HTMLElement) => {
    const list = element.querySelector("ul");
    const heading = element.querySelector("h2");
    const backdrop = element.parentElement;
    if (!list || !heading || !backdrop) throw new Error("The archive group dialog lost its heading or list.");
    const listStyle = getComputedStyle(list);
    const backdropStyle = getComputedStyle(backdrop);
    const listHeight = list.getBoundingClientRect().height;
    const buttons = [...element.querySelectorAll(".rename-thread-dialog__actions button")]
      .map((button) => button.getBoundingClientRect());
    return {
      backdropPadding: Number.parseFloat(backdropStyle.paddingTop) + Number.parseFloat(backdropStyle.paddingBottom),
      buttonsInView: buttons.length === 2 && buttons.every((rect) => rect.top >= 0 && rect.bottom <= innerHeight),
      // The dialog's height without the list, taken from its content
      // height plus its border so it holds when the dialog itself scrolls.
      chrome: element.scrollHeight + element.offsetHeight - element.clientHeight - listHeight,
      headingTop: heading.getBoundingClientRect().top,
      listAttachment: listStyle.backgroundAttachment,
      listBorder: Number.parseFloat(listStyle.borderTopWidth),
      listContent: list.scrollHeight + Number.parseFloat(listStyle.borderTopWidth) + Number.parseFloat(listStyle.borderBottomWidth),
      listHeight,
      listOverflows: list.scrollHeight > list.clientHeight + 1,
      viewportHeight: innerHeight,
    };
  });
  const violations: string[] = [];
  if (measured.headingTop < 0) violations.push(`R2: the heading opens at y=${Math.round(measured.headingTop)}`);
  const fits = measured.chrome + ARCHIVE_GROUP_LIST_PEEK_PX + measured.backdropPadding <= measured.viewportHeight;
  if (fits && !measured.buttonsInView) {
    violations.push(`R3: the buttons open out of view though ${Math.round(measured.chrome)}px of chrome fits ${measured.viewportHeight}px`);
  }
  if (measured.listOverflows
    && (measured.listBorder === 0 || !/\bscroll\b/.test(measured.listAttachment) || !/\blocal\b/.test(measured.listAttachment))) {
    violations.push(`R4: an overflowing list is unframed or unshaded (border ${measured.listBorder}px, attachment ${measured.listAttachment})`);
  }
  if (measured.listHeight + 0.5 < Math.min(ARCHIVE_GROUP_LIST_PEEK_PX, measured.listContent)) {
    violations.push(`R5: the list collapsed to ${Math.round(measured.listHeight)}px`);
  }
  // R1 scrolls, so it runs after every rule that reads the open state.
  for (const name of [/^Cancel$/, /^Archive \d+ Threads?$/]) {
    const button = dialog.getByRole("button", { name });
    await button.scrollIntoViewIfNeeded();
    const clickable = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit !== null && element.contains(hit);
    });
    if (!clickable) violations.push(`R1: ${name.source} cannot be scrolled into view and clicked`);
  }
  return violations;
}

/** Returns every scroller in the dialog to its opening offset. */
export async function resetArchiveGroupDialogScroll(page: Page): Promise<void> {
  await page.getByRole("dialog", { name: /^Archive \d+ Threads?\?$/ }).evaluate((element) => {
    for (const scroller of [element, ...element.querySelectorAll("*")]) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
  });
}
