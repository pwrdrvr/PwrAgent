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

export function assignGithubHeadingSlugs(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  return texts.map((text) => {
    const base = slugifyGithubHeading(text);
    if (!base) {
      return "";
    }
    let candidate = base;
    let suffix = 1;
    while (seen.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    seen.add(candidate);
    return candidate;
  });
}

function safeDecodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function headingSlugText(heading: HTMLElement): string {
  let text = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (
      node instanceof Element
      && node.tagName.toLowerCase() === "sup"
      && node.querySelector("a[data-footnote-ref]")
    ) {
      return;
    }
    for (const child of Array.from(node.childNodes)) {
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

  const elementsWithId = Array.from(root.querySelectorAll<HTMLElement>("[id]"));
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

  const headings = Array.from(
    root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
  ).filter((heading) => !heading.closest("section[data-footnotes]"));
  if (headings.length === 0) {
    return null;
  }

  const slugs = assignGithubHeadingSlugs(headings.map(headingSlugText));
  const targetSlug = decodedFragment.trim().toLowerCase();
  const strippedTargetSlug = targetSlug.startsWith(USER_CONTENT_PREFIX)
    ? targetSlug.slice(USER_CONTENT_PREFIX.length)
    : targetSlug;
  const rawSlug = rawFragment.trim().toLowerCase();

  for (let index = 0; index < headings.length; index += 1) {
    const slug = slugs[index];
    if (
      slug
      && (slug === targetSlug || slug === strippedTargetSlug || slug === rawSlug)
    ) {
      return headings[index] ?? null;
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
