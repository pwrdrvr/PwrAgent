const UNSAFE_FRAGMENT_CHARS = /[\s\u0000-\u001f\u007f]/;
const NON_SLUG_CHARS = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;
const USER_CONTENT_PREFIX = "user-content-";

export function isSafeMarkdownFragmentUrl(url: string): boolean {
  return (
    url.startsWith("#")
    && url.length > 1
    && !UNSAFE_FRAGMENT_CHARS.test(url)
  );
}

export function slugifyGithubHeading(text: string): string {
  return text
    .trim()
    .replace(/[\r\n\t]+/g, " ")
    .toLowerCase()
    .replace(NON_SLUG_CHARS, "")
    .replace(/ /g, "-");
}

class GithubHeadingSlugger {
  private readonly seen = new Set<string>();
  private readonly nextSuffix = new Map<string, number>();

  slug(text: string): string {
    const base = slugifyGithubHeading(text);
    if (!base) {
      return "";
    }
    if (!this.seen.has(base)) {
      this.seen.add(base);
      return base;
    }
    let suffix = this.nextSuffix.get(base) ?? 1;
    let candidate = `${base}-${suffix}`;
    while (this.seen.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    this.nextSuffix.set(base, suffix + 1);
    this.seen.add(candidate);
    return candidate;
  }
}

export function assignGithubHeadingSlugs(texts: readonly string[]): string[] {
  const slugger = new GithubHeadingSlugger();
  return texts.map((text) => slugger.slug(text));
}

function safeDecodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function hasDirectFootnoteRef(element: Element): boolean {
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    if (child.tagName.toLowerCase() === "a" && child.hasAttribute("data-footnote-ref")) {
      return true;
    }
  }
  return false;
}

function headingSlugText(heading: HTMLElement): string {
  let text = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (node instanceof Element) {
      const tag = node.tagName.toLowerCase();
      if (tag === "a" && node.hasAttribute("data-footnote-ref")) {
        return;
      }
      if (tag === "sup" && hasDirectFootnoteRef(node)) {
        return;
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(heading);
  return text;
}

export function findMarkdownAnchorTarget(
  root: ParentNode,
  href: string,
): HTMLElement | null {
  if (!isSafeMarkdownFragmentUrl(href)) {
    return null;
  }

  const rawFragment = href.slice(1);
  const decodedFragment = safeDecodeFragment(rawFragment);
  const exactCandidates = new Set<string>([
    rawFragment,
    decodedFragment,
    `${USER_CONTENT_PREFIX}${rawFragment}`,
    `${USER_CONTENT_PREFIX}${decodedFragment}`,
  ]);
  if (rawFragment.toLowerCase().startsWith(USER_CONTENT_PREFIX)) {
    exactCandidates.add(rawFragment.slice(USER_CONTENT_PREFIX.length));
  }
  if (decodedFragment.toLowerCase().startsWith(USER_CONTENT_PREFIX)) {
    exactCandidates.add(decodedFragment.slice(USER_CONTENT_PREFIX.length));
  }

  const lowerCandidates = new Set(
    Array.from(exactCandidates, (candidate) => candidate.toLowerCase()),
  );

  const elementsWithId = root.querySelectorAll<HTMLElement>("[id]");
  let caseInsensitiveMatch: HTMLElement | null = null;
  for (const element of elementsWithId) {
    const id = element.id;
    if (!id) {
      continue;
    }
    if (exactCandidates.has(id)) {
      return element;
    }
    if (!caseInsensitiveMatch && lowerCandidates.has(id.toLowerCase())) {
      caseInsensitiveMatch = element;
    }
  }
  if (caseInsensitiveMatch) {
    return caseInsensitiveMatch;
  }

  const headings = root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  const slugger = new GithubHeadingSlugger();
  const targetSlug = decodedFragment.trim().toLowerCase();
  const strippedTargetSlug = targetSlug.startsWith(USER_CONTENT_PREFIX)
    ? targetSlug.slice(USER_CONTENT_PREFIX.length)
    : targetSlug;
  const rawSlug = rawFragment.trim().toLowerCase();

  for (const heading of headings) {
    if (heading.closest("section[data-footnotes]")) {
      continue;
    }
    const slug = slugger.slug(headingSlugText(heading));
    if (
      slug
      && (slug === targetSlug || slug === strippedTargetSlug || slug === rawSlug)
    ) {
      return heading;
    }
  }

  return null;
}

export function orderedListMaxDigitCount(
  start: number | undefined,
  itemCount: number,
): number {
  const first = typeof start === "number" && Number.isFinite(start)
    ? Math.trunc(start)
    : 1;
  const count = Math.max(0, Math.trunc(itemCount));
  const last = count > 0 ? first + count - 1 : first;
  return Math.max(String(first).length, String(last).length);
}

export function orderedListGutter(
  start: number | undefined,
  itemCount: number,
): string | undefined {
  const digits = orderedListMaxDigitCount(start, itemCount);
  if (digits <= 1) {
    return undefined;
  }
  return `calc(${digits}ch + 1.15em)`;
}
