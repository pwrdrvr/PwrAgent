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

// How many animation frames (~2.5s at 60fps) the deep-link landing keeps the
// match pinned to center while a heavy thread finishes reflowing after load.
const HOLD_CENTERED_FRAMES = 150;

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
  /**
   * Turn id of the matched message, when the search result carried one. The
   * authoritative deep-link target: auto-load until this turn's `data-turn-id`
   * anchor renders, then scroll to it (the text highlight is a bonus that can
   * miss if markdown reflowed the snippet across nodes).
   */
  turnId?: string;
  /**
   * Bumped by the ⌘F owner on every press. A second ⌘F with the bar already
   * open pulls focus back into the field — the operator clicked into the
   * transcript, then reached for find again and expects to type.
   */
  focusNonce?: number;
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
  // Whether the deep-link target is on screen yet: the matched turn's
  // `data-turn-id` anchor has rendered, or a text match was found. Drives the
  // auto-load loop and the landing scroll so a turn that reflowed its snippet
  // text still stops paging and scrolls into view.
  const [targetFound, setTargetFound] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The search-seeded query we're auto-loading toward (deep-link), plus how
  // many older pages we've requested for it and whether we've landed on it.
  const seededRef = useRef<string | undefined>(undefined);
  const autoLoadsRef = useRef(0);
  const landedSeedRef = useRef<string | undefined>(undefined);
  // Armed only when the operator asks to be taken somewhere — typing a query,
  // or stepping between matches. Consumed by the paint effect below, which is
  // the sole owner of the manual scroll. Nothing else may move the transcript:
  // matches are re-collected on every transcript change (new messages, older
  // pages), and scrolling on that alone yanked the viewport back to a stale
  // match while the operator was reading elsewhere.
  const scrollIntentRef = useRef(false);
  // The query the current `matches` were collected for, so the recompute below
  // can tell "the operator retyped" from "the transcript moved under us".
  const collectedQueryRef = useRef(query);
  const onCloseRef = useRef(props.onClose);
  useEffect(() => {
    onCloseRef.current = props.onClose;
  });

  // Focus + select on mount, and again on each ⌘F while already open.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.focusNonce]);

  // Escape dismisses the bar from anywhere in the window, not just from the
  // field: the operator ⌘Fs, clicks into the transcript to read, then hits
  // Escape expecting find to go away. Anything that already claimed the key
  // (a dialog, the thread-jump popup, the field's own handler below) calls
  // preventDefault, so we never dismiss two surfaces with one press.
  useEffect(() => {
    // `KeyboardEvent` is React's synthetic type in this file (see the import);
    // a window listener gets the DOM one.
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
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
      setTargetFound(false);
      return;
    }
    const ranges = collectMatchRanges(container, query);
    setMatches(ranges);
    if (collectedQueryRef.current !== query) {
      // A different query is a different search: start at its first hit. This
      // reset lives here rather than in the input handler so it lands in the
      // same commit as the matches it applies to — moving the index on its own
      // would run the scroll effect against the PREVIOUS query's ranges and
      // strand the operator at the old first match.
      collectedQueryRef.current = query;
      setActiveIndex(0);
    } else {
      // Same query, transcript churned (new messages, older pages): hold the
      // operator's place, only clamping if their match went away.
      setActiveIndex((current) => (current < ranges.length ? current : 0));
    }
    const anchorPresent = props.turnId
      ? container.querySelector(`[data-turn-id="${CSS.escape(props.turnId)}"]`) !==
        null
      : false;
    setTargetFound(anchorPresent || ranges.length > 0);
  }, [query, props.refreshKey, props.containerRef, props.turnId]);

  // Paint the highlights, and scroll the active match into view only when the
  // operator asked for it. This effect re-runs on every transcript change —
  // `collectMatchRanges` hands back a fresh array each time — so an
  // unconditional scroll here is what made a live thread keep dragging the
  // viewport back to a match nobody was looking at any more. The intent flag is
  // consumed on every run (armed or not), so it can never leak into a later
  // transcript update.
  useEffect(() => {
    if (!highlightsSupported()) {
      return;
    }
    const scrollRequested = scrollIntentRef.current;
    scrollIntentRef.current = false;
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...matches));
    const active = matches[activeIndex];
    if (!active) {
      CSS.highlights.delete(HIGHLIGHT_ACTIVE);
      return;
    }
    CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(active));
    if (!scrollRequested) {
      return;
    }
    const anchor =
      active.startContainer instanceof Element
        ? active.startContainer
        : active.startContainer.parentElement;
    anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
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
      targetFound ||
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
  }, [autoLoadActive, targetFound, props.loadingMore, props.hasMoreHistory]);

  // Once the seeded deep-link match is found AND older-page loading has
  // settled, scroll it into view — once per seed, and held centered past the
  // transcript's own post-load scroll restoration (which otherwise snaps the
  // view back). The generic scroll effect above handles manual ⌘F + match
  // cycling; this one owns the deep-link landing.
  useEffect(() => {
    const seed = seededRef.current;
    if (
      !seed ||
      query !== seed ||
      !targetFound ||
      props.loadingMore ||
      landedSeedRef.current === seed
    ) {
      return;
    }
    const container = props.containerRef.current;
    // Resolve the scroll target, caching the confirmed text match so we don't
    // re-walk the turn every frame. A turn spans several transcript items
    // sharing one `data-turn-id` (user prompt + assistant reply + activities),
    // so we can't take the first — we scope the text search to each item and
    // pick the one actually containing the match (the assistant reply). The
    // matched text usually renders a frame or two after the turn anchor, so we
    // keep re-resolving until it appears; once found we reuse it while it stays
    // connected, re-resolving only if a re-render detaches the node.
    const turnId = props.turnId;
    const fallbackAnchor = ((): Element | null => {
      const active = matches[activeIndex];
      if (active?.startContainer instanceof Element) {
        return active.startContainer;
      }
      return active?.startContainer.parentElement ?? null;
    })();
    let cached: Element | null = null;
    let cachedIsMatch = false;
    const resolveTarget = (): Element | null => {
      if (cached && cachedIsMatch && cached.isConnected) {
        return cached;
      }
      if (turnId && container) {
        const items = container.querySelectorAll(
          `[data-turn-id="${CSS.escape(turnId)}"]`,
        );
        for (const item of items) {
          const node = collectMatchRanges(item as HTMLElement, seed)[0]
            ?.startContainer;
          if (node) {
            cached = node instanceof Element ? node : node.parentElement;
            cachedIsMatch = true;
            return cached;
          }
        }
        // No text hit in the turn yet (still rendering, or the snippet isn't
        // plain text e.g. a PR-number deep-link): aim at the last item — the
        // assistant reply — not the user prompt up top. Not cached as a match,
        // so later frames keep looking for the real hit.
        const last = items[items.length - 1];
        cached = last?.querySelector("*") ?? last ?? fallbackAnchor;
        cachedIsMatch = false;
        return cached;
      }
      cached = fallbackAnchor;
      cachedIsMatch = false;
      return cached;
    };
    if (!resolveTarget()) {
      return;
    }
    landedSeedRef.current = seed;
    // Hold the match centered across the whole settling window. A heavily
    // paginated thread keeps reflowing in bursts for a couple seconds after the
    // match renders — older pages just prepended, collapsed turn groups and
    // lazily loaded edit rows resize, and the transcript's own scroll
    // restoration tugs back — so a one-shot scroll lands then drifts off as
    // later content prepends above. Re-center every frame for the window
    // instead; once content truly stops moving, re-centering an already-
    // centered anchor is a no-op. Bail the instant the operator takes over — a
    // deep-link landing shouldn't fight someone who's already driving. Wheel
    // alone missed the ways people actually take over mid-landing (dragging the
    // scrollbar, clicking into the transcript), which left the loop re-centering
    // under them for the rest of the window.
    const TAKEOVER_EVENTS = ["wheel", "pointerdown", "touchstart"] as const;
    const deadline = HOLD_CENTERED_FRAMES;
    let frame = 0;
    let rafId = 0;
    let takenOver = false;
    const onUserScroll = (): void => {
      takenOver = true;
    };
    const stop = (): void => {
      cancelAnimationFrame(rafId);
      for (const name of TAKEOVER_EVENTS) {
        container?.removeEventListener(name, onUserScroll);
      }
    };
    for (const name of TAKEOVER_EVENTS) {
      container?.addEventListener(name, onUserScroll, { passive: true });
    }
    const tick = (): void => {
      if (takenOver || frame >= deadline) {
        stop();
        return;
      }
      resolveTarget()?.scrollIntoView({ block: "center", behavior: "auto" });
      frame += 1;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    // Tear down on unmount (bar closed) so the loop can't keep scrolling the
    // transcript or leak its wheel listener past close. `matches`/`activeIndex`
    // are intentionally excluded from deps: they change as the thread settles,
    // and re-running mid-hold would tear the loop down early (the landedSeedRef
    // guard already blocks a second landing). `fallbackAnchor` reads them once,
    // at landing — when the match is freshest.
    return stop;
  }, [props.loadingMore, query, targetFound, props.turnId, props.containerRef]);

  const step = useCallback(
    (delta: number) => {
      if (matches.length === 0) {
        return;
      }
      scrollIntentRef.current = true;
      setActiveIndex(
        (current) => (current + delta + matches.length) % matches.length,
      );
    },
    [matches.length],
  );

  // Typing is the operator asking to be taken to a match, so it arms the scroll.
  // The active index is reset where the new matches land (see above).
  const changeQuery = useCallback((next: string) => {
    scrollIntentRef.current = true;
    setQuery(next);
  }, []);

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
    autoLoadActive && !targetFound && (props.loadingMore || props.hasMoreHistory);
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
        onChange={(event) => changeQuery(event.target.value)}
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
