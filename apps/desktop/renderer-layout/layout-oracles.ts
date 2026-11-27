// CSSOM client and scroll widths are rounded to integer CSS pixels.
const tolerance = 1;

function describe(node: Element): string {
  return `${node.tagName.toLowerCase()}${Array.from(node.classList, (name) => `.${name}`).join("")}`;
}

function clipsHorizontally(node: Element): boolean {
  return getComputedStyle(node).overflowX !== "visible";
}

function clippingEdges(node: Element) {
  const left = node.getBoundingClientRect().left + node.clientLeft;
  return { left, right: left + node.clientWidth };
}

function measureLanes(sidebar: Element, findings: string[]): number {
  let lanes = 0;
  for (const element of [sidebar, ...sidebar.querySelectorAll("*")]) {
    const { overflowX, overflowY } = getComputedStyle(element);
    const scrollsSideways = overflowX === "auto" || overflowX === "scroll";
    const clipsVerticalLane = overflowX !== "visible" && (overflowY === "auto" || overflowY === "scroll");
    if (!scrollsSideways && !clipsVerticalLane) continue;
    lanes++;
    if (element.scrollWidth > element.clientWidth + tolerance) {
      findings.push(`Lane overflow in ${describe(element)}: scrollWidth ${element.scrollWidth}px, clientWidth ${element.clientWidth}px`);
    }
  }
  return lanes;
}

function measureChips(findings: string[]): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const chip of document.querySelectorAll(".pr-chip")) {
    const chipBox = chip.getBoundingClientRect();
    if (!chipBox.height) continue;
    const surface = chip.closest<HTMLElement>("[data-surface]")?.dataset.surface ?? "unknown surface";
    const label = chip.querySelector(".pr-chip__label");
    const labelText = label?.textContent ?? chip.textContent ?? "";
    // Count-only rollups (e.g. "3 PRs") do not name an individual PR.
    const expectedNumbers = labelText.match(/#\d+/g) ?? [];
    if (!expectedNumbers.length) continue;

    const range = document.createRange();
    const walker = label && document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let numbers = 0;
    for (let text = walker?.nextNode(); text; text = walker?.nextNode()) {
      for (const match of (text.textContent ?? "").matchAll(/#\d+/g)) {
        numbers++;
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const box = range.getBoundingClientRect();
        // The label and chip must contain the entire number even if their own
        // overflow is visible. An ancestor can still clip a correctly sized chip.
        for (let ancestor: Element | null = label; ancestor; ancestor = ancestor.parentElement) {
          const clips = clipsHorizontally(ancestor);
          if (!clips && ancestor !== label && ancestor !== chip) continue;
          const edges = clips ? clippingEdges(ancestor) : ancestor.getBoundingClientRect();
          if (!box.width || box.left < edges.left - tolerance || box.right > edges.right + tolerance) {
            findings.push(`Number clipped in ${surface}: ${match[0]} by ${describe(ancestor)} (${box.left.toFixed(1)}–${box.right.toFixed(1)}px inside ${edges.left.toFixed(1)}–${edges.right.toFixed(1)}px)`);
            break;
          }
        }
      }
    }
    if (numbers !== expectedNumbers.length) findings.push(`Missing number text in ${surface}: ${labelText}`);
    measured[surface] = (measured[surface] ?? 0) + numbers;
  }
  return measured;
}

function measureSurfaceEscapes(findings: string[]): void {
  for (const surface of document.querySelectorAll("[data-surface]:not([data-surface=sidebar])")) {
    const right = clippingEdges(surface).right - parseFloat(getComputedStyle(surface).paddingRight);
    for (const child of surface.querySelectorAll("*")) {
      const box = child.getBoundingClientRect();
      if (!box.width || box.right <= right + tolerance) continue;
      // An ellipsized title can have descendants laid out past the surface.
      // Measure the part that can actually paint before the surface clips it.
      let visibleRight = box.right;
      for (let parent = child.parentElement; parent && parent !== surface; parent = parent.parentElement) {
        if (clipsHorizontally(parent)) visibleRight = Math.min(visibleRight, clippingEdges(parent).right);
      }
      if (visibleRight > right + tolerance) {
        const text = child.textContent?.trim().slice(0, 60);
        findings.push(`Surface overflow in ${surface.getAttribute("data-surface")}: ${describe(child)} "${text}" escapes by ${(visibleRight - right).toFixed(1)}px`);
      }
    }
  }
}

export function measureLayout() {
  const findings: string[] = [];
  const sidebar = document.querySelector("aside.sidebar");
  const lanes = sidebar ? measureLanes(sidebar, findings) : 0;
  const numbers = measureChips(findings);
  measureSurfaceEscapes(findings);
  const hasAutoFix = Boolean(document.querySelector("[data-surface=details] [data-testid=details-pr-auto-fix]"));
  const rows = sidebar?.querySelectorAll("[data-thread-key]").length ?? 0;
  const activityLines = sidebar?.querySelectorAll(".sub-agent-activity").length ?? 0;
  const prefixedStackChips = sidebar?.querySelectorAll(".pr-chip--stacked .pr-chip__repo").length ?? 0;
  return { findings, lanes, numbers, hasAutoFix, rows, activityLines, prefixedStackChips };
}
