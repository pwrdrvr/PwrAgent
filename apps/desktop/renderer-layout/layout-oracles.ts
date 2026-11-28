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

function isVisible(element: Element): boolean {
  return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

type HorizontalEdges = { left: number; right: number };

function overflowDistance(box: HorizontalEdges, bounds: HorizontalEdges): number {
  return Math.max(bounds.left - box.left, box.right - bounds.right);
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
    if (!isVisible(chip)) continue;
    const surface = chip.closest<HTMLElement>("[data-surface]")?.dataset.surface ?? "unknown surface";
    const label = chip.querySelector(".pr-chip__label");
    const labelText = label?.textContent ?? chip.textContent ?? "";
    // Count-only rollups (e.g. "3 PRs") do not name an individual PR.
    const expectedNumbers = labelText.match(/#\d+/g) ?? [];
    if (!expectedNumbers.length) continue;

    const range = document.createRange();
    const walker = label && document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    const labelVisible = label !== null && isVisible(label);
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
          if (!box.width || !labelVisible || overflowDistance(box, edges) > tolerance) {
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

function measureControls(surface: Element, name: string, bounds: HorizontalEdges, findings: string[]): void {
  const controls = surface.querySelectorAll(
    "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio]",
  );
  for (const control of controls) {
    if (!isVisible(control)) continue;
    const box = control.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const overflow = overflowDistance(box, bounds);
    if (overflow > tolerance) {
      findings.push(`Control overflow in ${name}: ${describe(control)} escapes by ${overflow.toFixed(1)}px`);
      continue;
    }
    // Use the control's full box before intersecting with any clip. An inset
    // wrapper can hide part of a control even when its box fits the surface.
    for (let parent = control.parentElement; parent; parent = parent.parentElement) {
      if (!clipsHorizontally(parent)) continue;
      const clipped = overflowDistance(box, clippingEdges(parent));
      if (clipped > tolerance) {
        findings.push(`Control clipped in ${name}: ${describe(control)} by ${describe(parent)} (${clipped.toFixed(1)}px)`);
        break;
      }
    }
  }
}

function measureSurfaceEscapes(findings: string[]): void {
  for (const surface of document.querySelectorAll("aside.sidebar, [data-surface]:not([data-surface=sidebar])")) {
    const name = surface.getAttribute("data-surface") ?? "sidebar";
    const edges = clippingEdges(surface);
    const { paddingLeft, paddingRight } = getComputedStyle(surface);
    const bounds = { left: edges.left + parseFloat(paddingLeft), right: edges.right - parseFloat(paddingRight) };
    measureControls(surface, name, edges, findings);
    // Sidebar lanes have their own scrollWidth check.
    if (name === "sidebar") continue;
    for (const child of surface.querySelectorAll("*")) {
      const box = child.getBoundingClientRect();
      if (!box.width || overflowDistance(box, bounds) <= tolerance) continue;
      // An ellipsized title can have descendants laid out past the surface.
      // Measure the part that can actually paint before the surface clips it.
      let visibleLeft = box.left;
      let visibleRight = box.right;
      for (let parent = child.parentElement; parent && parent !== surface; parent = parent.parentElement) {
        if (!clipsHorizontally(parent)) continue;
        const clip = clippingEdges(parent);
        visibleLeft = Math.max(visibleLeft, clip.left);
        visibleRight = Math.min(visibleRight, clip.right);
      }
      const overflow = overflowDistance({ left: visibleLeft, right: visibleRight }, bounds);
      if (visibleRight > visibleLeft && overflow > tolerance) {
        const text = child.textContent?.trim().slice(0, 60);
        findings.push(`Surface overflow in ${name}: ${describe(child)} "${text}" escapes by ${overflow.toFixed(1)}px`);
      }
    }
  }
}

function measureSidebarRows(sidebar: Element) {
  return [...sidebar.querySelectorAll<HTMLElement>(".thread-row-shell[data-thread-key] > .thread-row")].map((row) => ({
    key: row.parentElement?.getAttribute("data-thread-key"),
    numberedLeads: [...row.querySelectorAll(".thread-row__chips .pr-chip:not(.pr-chip--rollup) .pr-chip__label")]
      .filter((label) => /#\d+/.test(label.textContent ?? "") && isVisible(label)).length,
    titleRollups: [...row.querySelectorAll(".thread-row__header .pr-chip--rollup")]
      .filter((rollup) => isVisible(rollup) && rollup.getBoundingClientRect().width > 0).length,
  }));
}

export function measureLayout() {
  const findings: string[] = [];
  const sidebar = document.querySelector("aside.sidebar");
  const lanes = sidebar ? measureLanes(sidebar, findings) : 0;
  const numbers = measureChips(findings);
  measureSurfaceEscapes(findings);
  const autoFix = document.querySelector("[data-surface=details] [data-testid=details-pr-auto-fix]");
  const hasAutoFix = Boolean(autoFix && isVisible(autoFix) && autoFix.getBoundingClientRect().width > 0);
  const sidebarRows = sidebar ? measureSidebarRows(sidebar) : [];
  const activityLines = sidebar?.querySelectorAll(".sub-agent-activity").length ?? 0;
  const prefixedStackChips = sidebar?.querySelectorAll(".pr-chip--stacked .pr-chip__repo").length ?? 0;
  return { findings, lanes, numbers, hasAutoFix, sidebarRows, activityLines, prefixedStackChips };
}
