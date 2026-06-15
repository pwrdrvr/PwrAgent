import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { CloseIcon, SearchIcon } from "../../icons";

const HIGHLIGHT_ALL = "thread-find";
const HIGHLIGHT_ACTIVE = "thread-find-active";

// Safety cap on the deep-link auto-load loop. `hasMoreHistory` normally stops
// it once the thread is fully loaded; this guards the pathological case where
// the matched text never renders in the DOM (e.g. markdown reflowed it across
// nodes) so we don't keep paging a giant thread forever.
const MAX_AUTO_LOADS = 60;

type ThreadFindBarProps = {
  /** The element whose text content is searched (the transcript). */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Re-run matching whenever this changes (thread switch, new messages), so
   * highlights track live transcript content.
   */
  refreshKey?: unknown;
  /**
   * When opened from a search result, pre-fill the input with this query and
   * auto-load older history until it's found (deep-link to the match).
   */
  initialQuery?: string;
  /** Whether older transcript pages remain (drives the deep-link auto-load). */
  hasMoreHistory?: boolean;
  /** Whether an older-page load is in flight. */
  loadingMore?: boolean;
  /** Load one older transcript page. */
  onLoadOlder?: () => Promise<void> | void;
  onClose: () => void;
};

/**
 * Whether this renderer supports the CSS Custom Highlight API. We highlight
 * matches with Ranges + `::highlight(...)` rather than mutating the
 * React-rendered transcript DOM. Electron's Chromium supports it; the guard
 * keeps the bar from throwing in any environment that doesn't.
 */
function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

function clearHighlights(): void {
  if (!highlightsSupported()) {
    return;
  }
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_ACTIVE);
}

function collectMatchRanges(container: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) {
    return [];
  }
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value || !value.toLowerCase().includes(needle)) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (parent && (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    const haystack = (node.nodeValue ?? "").toLowerCase();
    let from = 0;
    let index = haystack.indexOf(needle, from);
    while (index !== -1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      ranges.push(range);
      from = index + needle.length;
      index = haystack.indexOf(needle, from);
    }
    node = walker.nextNode();
  }
  return ranges;
}

export function ThreadFindBar(props: ThreadFindBarProps): ReactElement {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The search-seeded query we're auto-loading toward (deep-link), plus how
  // many older pages we've requested for it and whether we've landed on it.
  const seededRef = useRef<string | undefined>(undefined);
  const autoLoadsRef = useRef(0);
  const landedSeedRef = useRef<string | undefined>(undefined);

  // Focus + select on mount and whenever the bar is (re)opened.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Adopt a search-seeded query (deep-link from a search result) once per
  // distinct seed, re-arming the auto-load budget.
  useEffect(() => {
    const seed = props.initialQuery?.trim();
    if (seed && seed !== seededRef.current) {
      seededRef.current = seed;
      autoLoadsRef.current = 0;
      landedSeedRef.current = undefined;
      setQuery(seed);
    }
  }, [props.initialQuery]);

  // Recompute matches when the query or the underlying transcript changes.
  useEffect(() => {
    const container = props.containerRef.current;
    if (!container || !highlightsSupported()) {
      setMatches([]);
      return;
    }
    const ranges = collectMatchRanges(container, query);
    setMatches(ranges);
    setActiveIndex((current) => (current < ranges.length ? current : 0));
  }, [query, props.refreshKey, props.containerRef]);

  // Paint the highlights and scroll the active match into view.
  useEffect(() => {
    if (!highlightsSupported()) {
      return;
    }
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...matches));
    const active = matches[activeIndex];
    if (active) {
      CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(active));
      const anchor =
        active.startContainer instanceof Element
          ? active.startContainer
          : active.startContainer.parentElement;
      anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      CSS.highlights.delete(HIGHLIGHT_ACTIVE);
    }
  }, [matches, activeIndex]);

  // Drop highlights when the bar unmounts (closed).
  useEffect(() => clearHighlights, []);

  // Deep-link: while showing the seeded query with no match yet, page in older
  // history until it appears (or we run out / hit the cap). Each load grows the
  // transcript, bumping refreshKey, which re-collects matches and re-runs this.
  const autoLoadActive =
    seededRef.current !== undefined &&
    query === seededRef.current &&
    query !== "";
  useEffect(() => {
    if (
      !autoLoadActive ||
      matches.length > 0 ||
      props.loadingMore ||
      !props.hasMoreHistory ||
      autoLoadsRef.current >= MAX_AUTO_LOADS
    ) {
      return;
    }
    autoLoadsRef.current += 1;
    void props.onLoadOlder?.();
    // props intentionally excluded from deps: the effect re-runs as the
    // transcript/pagination state changes, and reads the latest callbacks.
  }, [autoLoadActive, matches.length, props.loadingMore, props.hasMoreHistory]);

  // Once the seeded deep-link match is found AND older-page loading has
  // settled, scroll it into view — once per seed, and re-asserted past the
  // transcript's own post-load scroll restoration (which otherwise snaps the
  // view back to the bottom). The generic scroll effect above handles manual
  // ⌘F + match cycling; this one owns the deep-link landing.
  useEffect(() => {
    const seed = seededRef.current;
    if (
      !seed ||
      query !== seed ||
      matches.length === 0 ||
      props.loadingMore ||
      landedSeedRef.current === seed
    ) {
      return;
    }
    landedSeedRef.current = seed;
    const active = matches[activeIndex];
    const anchor =
      active?.startContainer instanceof Element
        ? active.startContainer
        : active?.startContainer.parentElement;
    if (!anchor) {
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        anchor.scrollIntoView({ block: "center", behavior: "smooth" }),
      ),
    );
    window.setTimeout(
      () => anchor.scrollIntoView({ block: "center", behavior: "auto" }),
      300,
    );
  }, [matches, activeIndex, props.loadingMore, query]);

  const step = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        if (matches.length === 0) {
          return 0;
        }
        return (current + delta + matches.length) % matches.length;
      });
    },
    [matches.length],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  const count = matches.length;
  const searchingOlder =
    autoLoadActive && count === 0 && (props.loadingMore || props.hasMoreHistory);
  const status =
    query === ""
      ? ""
      : count > 0
        ? `${activeIndex + 1} of ${count}`
        : searchingOlder
          ? "Searching older messages…"
          : "No matches";

  return (
    <div className="thread-find" role="search" aria-label="Find in thread">
      <span className="thread-find__icon" aria-hidden>
        <SearchIcon size={14} />
      </span>
      <input
        ref={inputRef}
        className="thread-find__input"
        aria-label="Find in thread"
        placeholder="Find in thread"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="thread-find__count" aria-live="polite">
        {status}
      </span>
      <button
        className="thread-find__nav"
        type="button"
        aria-label="Previous match"
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <ChevronGlyph direction="up" />
      </button>
      <button
        className="thread-find__nav"
        type="button"
        aria-label="Next match"
        disabled={count === 0}
        onClick={() => step(1)}
      >
        <ChevronGlyph direction="down" />
      </button>
      <button
        className="thread-find__close"
        type="button"
        aria-label="Close find"
        onClick={props.onClose}
      >
        <CloseIcon size={14} aria-hidden />
      </button>
    </div>
  );
}

function ChevronGlyph(props: { direction: "up" | "down" }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.direction === "up" ? <path d="m6 14 6-6 6 6" /> : <path d="m6 10 6 6 6-6" />}
    </svg>
  );
}
