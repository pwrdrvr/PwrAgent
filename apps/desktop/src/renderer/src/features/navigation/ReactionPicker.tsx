import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ClockIcon } from "../../icons/ClockIcon";
import { CloseIcon } from "../../icons/CloseIcon";
import { SearchIcon } from "../../icons/SearchIcon";
import { SmileyIcon } from "../../icons/SmileyIcon";
import { UserIcon } from "../../icons/UserIcon";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import type { ReactionEmojiCatalog } from "./reaction-emoji-catalog";
import {
  BASE_REACTION_ENTRIES,
  LABEL_LETTER_REACTIONS,
  LABEL_NUMBER_REACTIONS,
  QUICK_REACTIONS,
  REACTION_CATEGORIES,
  REACTION_PICKER_COLUMNS,
  computeReactionPickerPosition,
  createLazyValueCache,
  moveReactionGridIndex,
  normalizeEmojiKey,
  readRecentReactions,
  recordRecentReactionList,
  searchReactionEmojis,
  writeRecentReactions,
  type ReactionCategoryId,
  type ReactionEmojiEntry,
  type ReactionPickerPlacement,
} from "./reaction-picker-model";

const DEFAULT_PICKER_WIDTH = 316;
const DEFAULT_PICKER_HEIGHT = 378;

const catalogCache = createLazyValueCache<ReactionEmojiCatalog>(() =>
  import("./reaction-emoji-catalog").then((module) =>
    module.loadReactionEmojiCatalog(),
  ),
);

const BASE_BY_KEY = new Map<string, ReactionEmojiEntry>(
  BASE_REACTION_ENTRIES.map((entry) => [normalizeEmojiKey(entry.emoji), entry]),
);

function resolveEntryForEmoji(
  emoji: string,
  catalog: ReactionEmojiCatalog | undefined,
): ReactionEmojiEntry {
  const key = normalizeEmojiKey(emoji);
  return (
    catalog?.byKey.get(key)
    ?? BASE_BY_KEY.get(key)
    ?? {
      emoji,
      name: emoji,
      shortcode: "reaction",
      category: "quick",
      keywords: [emoji],
    }
  );
}

type ReactionSection = {
  id: string;
  label: string;
  entries: readonly ReactionEmojiEntry[];
};

function CategoryIcon(props: { category: ReactionCategoryId }) {
  const svgProps = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (props.category) {
    case "quick":
      return <ClockIcon size={14} aria-hidden="true" />;
    case "smileys_emotion":
      return <SmileyIcon size={14} aria-hidden="true" />;
    case "people_body":
      return <UserIcon size={14} aria-hidden="true" />;
    case "animals_nature":
      return (
        <svg {...svgProps}>
          <path d="M5 19c8 0 14-5 14-14-9 0-14 6-14 14Z" />
          <path d="M5 19c2.5-2.5 5.5-5.5 9-9" />
        </svg>
      );
    case "food_drink":
      return (
        <svg {...svgProps}>
          <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z" />
          <path d="M16 10h2a2.5 2.5 0 0 1 0 5h-2" />
          <path d="M7 5v1.5M11 4.5v2" />
        </svg>
      );
    case "travel_activities":
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="9" />
          <polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5 15.5 8.5" />
        </svg>
      );
    case "objects":
      return (
        <svg {...svgProps}>
          <path d="M9 18h6" />
          <path d="M10 21h4" />
          <path d="M12 3a6 6 0 0 0-3.5 10.9c.7.5 1.1 1.3 1.2 2.1h4.6c.1-.8.5-1.6 1.2-2.1A6 6 0 0 0 12 3Z" />
        </svg>
      );
    case "symbols":
      return (
        <svg {...svgProps}>
          <path d="M12 4.5 14.3 9l5 .7-3.6 3.5.9 5L12 15.8 7.4 18.2l.9-5L4.7 9.7l5-.7L12 4.5Z" />
        </svg>
      );
    case "labels":
      return (
        <svg {...svgProps}>
          <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />
        </svg>
      );
    case "flags":
      return (
        <svg {...svgProps}>
          <path d="M6 20V5" />
          <path d="M6 5h11l-2.2 4 2.2 4H6" />
        </svg>
      );
  }
}

type ReactionPickerProps = {
  open: boolean;
  /** Emoji currently present on the thread; shown as toggled-on. */
  current: string[];
  /** Element the picker anchors to (the add-reaction button). */
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (emoji: string) => void;
  onDismiss: () => void;
};

type OpenReactionPickerProps = Omit<ReactionPickerProps, "open">;

export function ReactionPicker(props: ReactionPickerProps) {
  if (!props.open) {
    return null;
  }
  return (
    <OpenReactionPicker
      current={props.current}
      anchorRef={props.anchorRef}
      onSelect={props.onSelect}
      onDismiss={props.onDismiss}
    />
  );
}

function OpenReactionPicker(props: OpenReactionPickerProps) {
  const { current, anchorRef, onSelect, onDismiss } = props;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [placement, setPlacement] = useState<ReactionPickerPlacement>();
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<ReactionCategoryId>("quick");
  const [catalog, setCatalog] = useState<ReactionEmojiCatalog | undefined>(() =>
    catalogCache.getCached(),
  );
  const [recents, setRecents] = useState<string[]>(() => readRecentReactions());
  const [previewEntry, setPreviewEntry] = useState<ReactionEmojiEntry | undefined>();

  // Warm the full emoji catalog chunk lazily on first open so startup stays lean.
  // A transient import failure clears the cached promise so the next open retries.
  useEffect(() => {
    const cached = catalogCache.getCached();
    if (cached) {
      setCatalog(cached);
      return;
    }
    let cancelled = false;
    void catalogCache
      .load()
      .then((loaded) => {
        if (!cancelled) {
          setCatalog(loaded);
        }
      })
      .catch(() => {
        // Keep Quick + Labels usable; next open retries the chunk load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Register Escape handling with the shared dismissable layer stack so
  // Escape closes only this popover and returns focus to the trigger.
  useDismissableLayer({
    open: true,
    onDismiss,
    surfaceRef,
    triggerRef: anchorRef,
  });

  const isPlaced = placement !== undefined;

  // The picker is portaled to <body> with position:fixed because the sidebar
  // scroll container clips overflow on both axes. Compute placement from the
  // anchor rect and re-measure once the portal mounts, when content height
  // changes (category switch, search, async catalog load), or on viewport
  // scroll/resize. Ignore scroll events inside the picker's own grid body.
  useLayoutEffect(() => {
    const update = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const measured = surfaceRef.current?.getBoundingClientRect();
      const width =
        measured && measured.width > 0 ? measured.width : DEFAULT_PICKER_WIDTH;
      const height =
        measured && measured.height > 0 ? measured.height : DEFAULT_PICKER_HEIGHT;
      const next = computeReactionPickerPosition(
        anchorRect,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPlacement((prev) =>
        prev
        && prev.top === next.top
        && prev.left === next.left
        && prev.side === next.side
          ? prev
          : next,
      );
    };

    const handleScroll = (event: Event): void => {
      if (
        event.target instanceof Node
        && surfaceRef.current?.contains(event.target)
      ) {
        return;
      }
      update();
    };

    update();

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function" && surfaceRef.current) {
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(surfaceRef.current);
    }

    window.addEventListener("resize", update);
    window.addEventListener("scroll", handleScroll, { capture: true });
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", handleScroll, { capture: true });
    };
  }, [anchorRef, isPlaced, activeCategory, query, catalog, recents.length, current.length]);

  // Focus the search field immediately once the picker is mounted and placed.
  useEffect(() => {
    if (!isPlaced) {
      return;
    }
    searchInputRef.current?.focus();
  }, [isPlaced]);

  // Dismiss on pointer-down outside both the popover and its trigger button
  // (ignoring the trigger avoids a dismiss-then-reopen flicker on click).
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (
        surfaceRef.current?.contains(target)
        || anchorRef.current?.contains(target)
      ) {
        return;
      }
      onDismiss();
    };
    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
    };
  }, [onDismiss, anchorRef]);

  // Map normalized key -> exact stored reaction string on the thread so
  // toggling off a stored VS16 variant (e.g. "❤" vs "❤️") removes the exact
  // stored entry instead of appending a duplicate.
  const currentByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const emoji of current) {
      const key = normalizeEmojiKey(emoji);
      if (!map.has(key)) {
        map.set(key, emoji);
      }
    }
    return map;
  }, [current]);

  const isSearching = query.trim().length > 0;

  const searchResults = useMemo(() => {
    if (!isSearching) {
      return [];
    }
    const source = catalog?.all ?? BASE_REACTION_ENTRIES;
    return searchReactionEmojis(source, query);
  }, [catalog, isSearching, query]);

  const sections = useMemo<ReactionSection[]>(() => {
    if (isSearching) {
      if (searchResults.length === 0) {
        return [];
      }
      return [{ id: "search", label: "Matches", entries: searchResults }];
    }

    if (activeCategory === "quick") {
      const result: ReactionSection[] = [];
      const shownKeys = new Set<string>();

      const recentEntries = recents.map((emoji) =>
        resolveEntryForEmoji(emoji, catalog),
      );
      if (recentEntries.length > 0) {
        for (const entry of recentEntries) {
          shownKeys.add(normalizeEmojiKey(entry.emoji));
        }
        result.push({
          id: "recent",
          label: "Recent",
          entries: recentEntries,
        });
      }

      for (const entry of QUICK_REACTIONS) {
        shownKeys.add(normalizeEmojiKey(entry.emoji));
      }

      const extraActive: ReactionEmojiEntry[] = [];
      for (const emoji of current) {
        const key = normalizeEmojiKey(emoji);
        if (shownKeys.has(key)) {
          continue;
        }
        shownKeys.add(key);
        const resolved = resolveEntryForEmoji(emoji, catalog);
        extraActive.push(
          resolved.emoji === emoji ? resolved : { ...resolved, emoji },
        );
      }

      if (extraActive.length > 0) {
        result.push({
          id: "active",
          label: "On this thread",
          entries: extraActive,
        });
      }

      result.push({
        id: "quick",
        label: "Quick",
        entries: QUICK_REACTIONS,
      });
      return result;
    }

    if (activeCategory === "labels") {
      return [
        { id: "numbers", label: "Numbers", entries: LABEL_NUMBER_REACTIONS },
        { id: "letters", label: "Letters", entries: LABEL_LETTER_REACTIONS },
      ];
    }

    const entries = catalog?.byCategory[activeCategory] ?? [];
    const meta = REACTION_CATEGORIES.find((item) => item.id === activeCategory);
    return [
      {
        id: activeCategory,
        label: meta?.label ?? "Emoji",
        entries,
      },
    ];
  }, [activeCategory, catalog, current, isSearching, recents, searchResults]);

  const sectionLengths = useMemo(
    () => sections.map((section) => section.entries.length),
    [sections],
  );

  const flatEntries = useMemo(
    () => sections.flatMap((section) => section.entries),
    [sections],
  );

  const handleSelectEntry = useCallback(
    (entry: ReactionEmojiEntry, fromKeyboard: boolean) => {
      const key = normalizeEmojiKey(entry.emoji);
      const storedActive = currentByKey.get(key);
      if (storedActive === undefined) {
        const nextRecents = recordRecentReactionList(recents, entry.emoji);
        setRecents(nextRecents);
        writeRecentReactions(nextRecents);
      }
      if (fromKeyboard) {
        anchorRef.current?.focus();
      }
      onSelect(storedActive ?? entry.emoji);
    },
    [anchorRef, currentByKey, onSelect, recents],
  );

  const focusGridButton = useCallback((index: number): void => {
    const button = gridBodyRef.current?.querySelector<HTMLButtonElement>(
      `[data-reaction-index="${index}"]`,
    );
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const handleSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Enter" && flatEntries.length > 0) {
      event.preventDefault();
      handleSelectEntry(flatEntries[0]!, true);
      return;
    }
    if (event.key === "ArrowDown" && flatEntries.length > 0) {
      event.preventDefault();
      focusGridButton(0);
    }
  };

  const handleGridKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    entry: ReactionEmojiEntry,
    flatIndex: number,
  ): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelectEntry(entry, true);
      return;
    }
    if (
      event.key === "ArrowRight"
      || event.key === "ArrowLeft"
      || event.key === "ArrowDown"
      || event.key === "ArrowUp"
      || event.key === "Home"
      || event.key === "End"
    ) {
      event.preventDefault();
      const next = moveReactionGridIndex(
        flatIndex,
        event.key,
        sectionLengths,
        REACTION_PICKER_COLUMNS,
      );
      if (next === undefined) {
        searchInputRef.current?.focus();
      } else {
        focusGridButton(next);
      }
      return;
    }
    // Typing a printable character while focused in the grid jumps straight to
    // search so operators never need to click back into the search box.
    if (
      event.key.length === 1
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey
    ) {
      event.preventDefault();
      setQuery((prev) => prev + event.key);
      setPreviewEntry(undefined);
      if (gridBodyRef.current) {
        gridBodyRef.current.scrollTop = 0;
      }
      searchInputRef.current?.focus();
    }
  };

  const handleCategoryChange = (category: ReactionCategoryId): void => {
    setActiveCategory(category);
    setPreviewEntry(undefined);
    if (gridBodyRef.current) {
      gridBodyRef.current.scrollTop = 0;
    }
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % REACTION_CATEGORIES.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (index - 1 + REACTION_CATEGORIES.length) % REACTION_CATEGORIES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = REACTION_CATEGORIES.length - 1;
    } else if (event.key === "ArrowDown" && flatEntries.length > 0) {
      event.preventDefault();
      focusGridButton(0);
      return;
    }
    if (nextIndex !== undefined) {
      event.preventDefault();
      const nextCategory = REACTION_CATEGORIES[nextIndex]!;
      handleCategoryChange(nextCategory.id);
      tabRefs.current[nextIndex]?.focus();
    }
  };

  if (!placement) {
    return null;
  }

  const activePreview =
    previewEntry ?? (isSearching ? searchResults[0] : undefined);
  const activePreviewIsOn = activePreview
    ? currentByKey.has(normalizeEmojiKey(activePreview.emoji))
    : false;

  let runningIndex = 0;

  return createPortal(
    <div
      ref={surfaceRef}
      className="reaction-picker"
      role="dialog"
      aria-label="Add reaction"
      data-placement={placement.side}
      style={{ top: placement.top, left: placement.left }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="reaction-picker__search">
        <SearchIcon
          size={13}
          className="reaction-picker__search-icon"
          aria-hidden="true"
        />
        <input
          ref={searchInputRef}
          type="search"
          aria-label="Search emoji"
          className="reaction-picker__search-input"
          placeholder="Search emoji…"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setPreviewEntry(undefined);
            if (gridBodyRef.current) {
              gridBodyRef.current.scrollTop = 0;
            }
          }}
          onKeyDown={handleSearchKeyDown}
        />
        {query.length > 0 ? (
          <button
            type="button"
            className="reaction-picker__search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setPreviewEntry(undefined);
              searchInputRef.current?.focus();
            }}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {!isSearching ? (
        <div
          className="reaction-picker__tabs"
          role="tablist"
          aria-label="Emoji categories"
        >
          {REACTION_CATEGORIES.map((category, index) => {
            const selected = activeCategory === category.id;
            return (
              <button
                key={category.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={category.label}
                tabIndex={selected ? 0 : -1}
                className={`reaction-picker__tab tooltip-target${
                  selected ? " is-active" : ""
                }`}
                data-tooltip={category.label}
                onClick={() => handleCategoryChange(category.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <CategoryIcon category={category.id} />
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        ref={gridBodyRef}
        className="reaction-picker__body"
        onMouseLeave={() => setPreviewEntry(undefined)}
      >
        {sections.length === 0 ? (
          <div className="reaction-picker__empty" role="status">
            No matching emoji
          </div>
        ) : (
          sections.map((section) => {
            if (section.entries.length === 0) {
              return (
                <div
                  key={section.id}
                  className="reaction-picker__empty"
                  role="status"
                >
                  Loading emoji…
                </div>
              );
            }
            return (
              <div
                key={section.id}
                className="reaction-picker__section"
                role="group"
                aria-label={section.label}
              >
                <div className="reaction-picker__section-label">
                  {section.label}
                </div>
                <div className="reaction-picker__grid">
                  {section.entries.map((entry) => {
                    const flatIndex = runningIndex++;
                    const isOn = currentByKey.has(normalizeEmojiKey(entry.emoji));
                    const isSearchTopMatch =
                      isSearching && flatIndex === 0 && !previewEntry;
                    return (
                      <button
                        key={`${section.id}:${normalizeEmojiKey(entry.emoji)}`}
                        type="button"
                        data-reaction-index={flatIndex}
                        aria-label={entry.name}
                        aria-pressed={isOn}
                        className={`reaction-picker__option${
                          isOn ? " is-active" : ""
                        }${isSearchTopMatch ? " is-match" : ""}`}
                        onMouseEnter={() => setPreviewEntry(entry)}
                        onFocus={() => setPreviewEntry(entry)}
                        onClick={() => handleSelectEntry(entry, false)}
                        onKeyDown={(event) =>
                          handleGridKeyDown(event, entry, flatIndex)
                        }
                      >
                        <span aria-hidden="true">{entry.emoji}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="reaction-picker__footer">
        {activePreview ? (
          <>
            <span className="reaction-picker__preview-emoji" aria-hidden="true">
              {activePreview.emoji}
            </span>
            <span className="reaction-picker__preview-name">
              {activePreview.name}
            </span>
            <span className="reaction-picker__preview-meta">
              {activePreviewIsOn ? "Active" : `:${activePreview.shortcode}:`}
            </span>
          </>
        ) : (
          <span className="reaction-picker__footer-hint">
            Pick a reaction
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}
