import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type {
  AppServerSkillSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { FolderIcon, PullRequestIcon, ThreadIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  buildDirectoryReferenceInsertText,
  filterDirectoryReferenceCandidates,
  findDirectoryReferenceTrigger,
} from "../../lib/directory-references";
import {
  buildHashReferenceOptions,
  describeHashReferenceThread,
  findHashReferenceTrigger,
  formatHashReferenceThreadLabel,
  formatHashReferenceThreadTooltip,
  hashReferenceAnchorKey,
  HASH_ANCHOR_COLD_QUERY_LENGTH,
} from "../../lib/hash-references";
import { buildSkillTooltip, findSkillTrigger } from "../../lib/skill-mentions";
import {
  FEDERATED_THREAD_SEARCH_LIMIT,
  useFederatedThreadSearch,
} from "../../lib/useFederatedThreadSearch";
import type {
  ComposerInputHandle,
  ComposerSkillToken,
} from "./ComposerInputTypes";
import {
  adjustSkillTokenIndexesForTextChange,
  createComposerDirectoryToken,
  createComposerPullRequestToken,
  createComposerSkillToken,
  createComposerThreadToken,
  filterSkillAutocompleteCandidates,
  getComposerSkillTokensSignature,
  resolveThreadSummaryReference,
  serializeDraftWithSkillTokens,
} from "./composer-mention-tokens";
import { HighlightedAutocompleteLabel } from "./HighlightedAutocompleteLabel";

/**
 * The populations a compact composer's mention popovers pick from.
 *
 * Every field is optional and an absent one simply retires its trigger
 * character back to prose — a host that supplies nothing gets exactly the
 * literal `$`/`@`/`#` behaviour the compact composer had before mentions
 * existed. That is deliberate: `CompactComposer` is shared, and a required
 * source would be a breaking change for the next surface that adopts it.
 *
 * Populations are values, not fetches: the host decides where they come
 * from and how they are cached. The two `ensure*` callbacks are how a
 * popover says "I am open now" so a host can load lazily instead of paying
 * for a list the operator may never ask for.
 */
export type ComposerMentionSources = {
  /**
   * Identity key of the thread being written in. Never offered as a `#`
   * candidate — referencing the current thread tells the agent nothing it
   * does not already have.
   */
  currentThreadKey?: string;
  /** Tracked directories behind `@`. */
  directories?: readonly NavigationDirectorySummary[];
  /** Called when `@` or `#` opens a popover. */
  ensureNavigationLoaded?: () => void;
  /** Called when `$` opens a popover. */
  ensureSkillsLoaded?: () => void;
  /**
   * Peer thread search behind `#`. Omitted leaves `#` local-only; the
   * shared hook otherwise falls back to this window's own bridge.
   */
  searchRemoteThreads?: DesktopApi["jumpSearchRemoteThreads"];
  /** Skills behind `$`. Thread-scoped, so the host owns this fetch. */
  skills?: readonly AppServerSkillSummary[];
  /** Local threads (and, through them, pull requests) behind `#`. */
  threads?: readonly NavigationThreadSummary[];
};

/** A draft and its chips, together — the pair a failed send must restore. */
export type ComposerMentionDraft = {
  draft: string;
  skillTokens: ComposerSkillToken[];
};

export type ComposerMentions = {
  /** `aria-activedescendant` for the editor while a popover is open. */
  activeOptionId?: string;
  clear: () => void;
  /** The plain draft; mention chips are zero-width in it. */
  draft: string;
  handleChange: (value: string, skillTokens?: ComposerSkillToken[]) => void;
  /** Returns whether the popover consumed the key. */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => boolean;
  inputRef: RefObject<ComposerInputHandle | null>;
  /** `aria-controls` for the editor while a popover is open. */
  listboxId?: string;
  open: boolean;
  popover: ReactNode;
  /** Put a failed send's draft back, unless the operator has typed since. */
  restore: (snapshot: ComposerMentionDraft) => void;
  /**
   * Stable between renders unless a token actually changed: the editor
   * re-syncs its whole document whenever this prop changes identity.
   */
  skillTokens: ComposerSkillToken[];
  snapshot: ComposerMentionDraft;
  /** Outgoing text: the draft with every chip spliced back as markdown. */
  text: string;
};

type MentionKind = "directories" | "hash" | "skills";

const NO_DIRECTORIES: readonly NavigationDirectorySummary[] = [];
const NO_SKILLS: readonly AppServerSkillSummary[] = [];
const NO_THREADS: readonly NavigationThreadSummary[] = [];

/**
 * Mention autocomplete for a compact composer.
 *
 * The full composer's popovers are woven through a 12,000-line component
 * that also owns queued turns, review mode, attachments, and draft
 * recovery. This is the same behaviour with none of that: the trigger
 * detection, candidate ranking, token minting, and markdown serialization
 * are all the shared modules the full composer calls, and what lives here
 * is only the part that is genuinely about *this* surface — which popover
 * is open, which row is highlighted, and where the caret lands after an
 * insert.
 *
 * The hook owns the draft as well as the tokens because an insert has to
 * move both at once: a mention chip is zero-width in the plain draft, so a
 * token whose index is applied a render later than the text it sits in
 * would splice its markdown at the wrong offset.
 *
 * The popover renders *inside* the host's field rather than through a
 * portal. On the star map that is what keeps it inside `.star-map-chat-card`,
 * which is the selector every camera-gesture guard tests against —
 * `isStarMapTypingTarget`, `shouldPanOnWheel`, `shouldStartCanvasPan`. A
 * body portal would sit outside all three and arrow keys over an open list
 * would fly the camera.
 */
export function useComposerMentions(params: {
  /**
   * Mirrors the host's own disabled state. A disabled composer still
   * forwards keys from a field that was focused before it was disabled, so
   * without this a popover stays live and Enter commits a chip into a
   * composer that is refusing new text.
   */
  disabled?: boolean;
  sources?: ComposerMentionSources;
}): ComposerMentions {
  const { sources } = params;
  const inputRef = useRef<ComposerInputHandle | null>(null);
  const listboxId = useId();
  // One state, not two: an insert has to move the draft and its tokens in
  // the same commit, and a bounced send has to put both back or neither.
  const [content, setContent] = useState<ComposerMentionDraft>(() => ({
    draft: "",
    skillTokens: [],
  }));
  const { draft, skillTokens } = content;
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | undefined>(
    undefined,
  );
  /**
   * `#` anchors that have run long with nothing to show. Unlike `$` and
   * `@`, a `#` query spans spaces, so nothing else retires it and a `#`
   * mid-sentence would keep the picker armed — and the peer search
   * re-firing — for the rest of the line.
   */
  const [coldHashAnchors, setColdHashAnchors] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * The stale echo an in-flight programmatic insert is expected to produce.
   *
   * `ComposerTiptapInput` re-emits its still-pre-insert content through
   * `onChange` when the editability sync runs, which lands after the
   * `flushSync` below has already committed the new draft. Swallowing that
   * one echo is what stops the two sides ping-ponging the insert away.
   */
  const pendingProgrammaticChangeRef = useRef<
    { staleDraft: string; staleSkillTokensSignature: string } | undefined
  >(undefined);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const skills = sources?.skills ?? NO_SKILLS;
  const directories = sources?.directories ?? NO_DIRECTORIES;
  const threads = sources?.threads ?? NO_THREADS;

  // Read live from the editor rather than from tracked state: the caret
  // moves on clicks and arrow keys that never produce an `onChange`, and a
  // trigger resolved against a stale caret opens the wrong popover.
  const selectionStart = Math.min(
    inputRef.current?.selectionStart ?? draft.length,
    draft.length,
  );
  const skillTrigger = findSkillTrigger(draft, selectionStart);
  const directoryTrigger = findDirectoryReferenceTrigger(draft, selectionStart);
  const rawHashTrigger = findHashReferenceTrigger(draft, selectionStart);
  const hashTrigger =
    rawHashTrigger
    && !coldHashAnchors.has(hashReferenceAnchorKey(rawHashTrigger.query))
      ? rawHashTrigger
      : undefined;

  const skillQuery = skillTrigger?.query;
  const directoryQuery = directoryTrigger?.query;
  const hashQuery = hashTrigger?.query;

  // Opt-in, and gated on the query as well as the callback: the shared
  // search hook otherwise resolves this window's own bridge, which would
  // have a host that supplies no sources at all firing a federated search
  // the first time someone typed `#` in a sentence.
  const remoteSearch = sources?.searchRemoteThreads;
  const {
    available: remoteSearchAvailable,
    loading: remoteSearchLoading,
    results: remoteThreads,
    settledQuery: remoteSettledQuery,
  } = useFederatedThreadSearch({
    query: remoteSearch ? (hashQuery ?? "") : "",
    limit: FEDERATED_THREAD_SEARCH_LIMIT,
    search: remoteSearch,
  });

  const skillOptions = useMemo(
    () =>
      skillQuery === undefined
        ? []
        : filterSkillAutocompleteCandidates(skills, skillQuery),
    [skillQuery, skills],
  );
  const directoryOptions = useMemo(
    () =>
      directoryQuery === undefined
        ? []
        : filterDirectoryReferenceCandidates([...directories], directoryQuery),
    [directories, directoryQuery],
  );
  const hashOptions = useMemo(
    () =>
      hashQuery === undefined
        ? []
        : buildHashReferenceOptions({
            currentThreadKey: sources?.currentThreadKey,
            localThreads: threads,
            query: hashQuery,
            remoteThreads,
          }),
    [hashQuery, remoteThreads, sources?.currentThreadKey, threads],
  );

  // Same precedence the full composer uses. A trigger with no candidates
  // yields to the next one rather than holding an empty popover open.
  const kind: MentionKind | undefined =
    skillTrigger && skillOptions.length > 0
      ? "skills"
      : directoryTrigger && directoryOptions.length > 0
        ? "directories"
        : hashTrigger && hashOptions.length > 0
          ? "hash"
          : undefined;
  const query =
    kind === "skills"
      ? (skillQuery ?? "")
      : kind === "directories"
        ? (directoryQuery ?? "")
        : (hashQuery ?? "");
  const optionCount =
    kind === "skills"
      ? skillOptions.length
      : kind === "directories"
        ? directoryOptions.length
        : kind === "hash"
          ? hashOptions.length
          : 0;
  const activeTrigger =
    kind === "skills"
      ? skillTrigger
      : kind === "directories"
        ? directoryTrigger
        : kind === "hash"
          ? hashTrigger
          : undefined;
  /**
   * Identity of the popover Escape retires: its kind, the trigger's
   * position, and the query.
   *
   * The offsets are not decoration. Keyed on the query alone, dismissing
   * `$dep` once would suppress every later `$dep` in the same message —
   * and, with the retirement below, a backspace-and-retype of the same
   * word too. The full composer keys its `dismissedAutocompleteKey` the
   * same way for the same reason.
   */
  const dismissKey = activeTrigger
    ? `${kind}:${activeTrigger.start}:${activeTrigger.end}:${query}`
    : undefined;
  const open =
    Boolean(kind) && !params.disabled && dismissKey !== dismissedKey;
  const activeOption = Math.min(activeIndex, Math.max(optionCount - 1, 0));

  const skillsTriggered = Boolean(skillTrigger);
  const navigationTriggered = Boolean(directoryTrigger || rawHashTrigger);
  const ensureSkillsLoaded = sources?.ensureSkillsLoaded;
  const ensureNavigationLoaded = sources?.ensureNavigationLoaded;
  // Keyed on the trigger existing, NOT on there being candidates: an empty
  // population is exactly the state a load is supposed to fix.
  useEffect(() => {
    if (skillsTriggered) ensureSkillsLoaded?.();
  }, [ensureSkillsLoaded, skillsTriggered]);
  useEffect(() => {
    if (navigationTriggered) ensureNavigationLoaded?.();
  }, [ensureNavigationLoaded, navigationTriggered]);

  // Have the peers answered about *this* query? `loading` is set inside the
  // search hook's effect, so for one commit after a keystroke it still
  // reads `false` while holding the previous query's results.
  const remoteSearchSettled =
    !remoteSearch
    || !remoteSearchAvailable
    || (!remoteSearchLoading
      && remoteSettledQuery === (rawHashTrigger?.query ?? "").trim());
  const rawHashQuery = rawHashTrigger?.query;
  useEffect(() => {
    if (
      rawHashQuery === undefined
      || rawHashQuery.length < HASH_ANCHOR_COLD_QUERY_LENGTH
      || !remoteSearchSettled
      || hashOptions.length > 0
    ) {
      return;
    }
    const key = hashReferenceAnchorKey(rawHashQuery);
    setColdHashAnchors((current) =>
      current.has(key) ? current : new Set(current).add(key),
    );
  }, [hashOptions.length, rawHashQuery, remoteSearchSettled]);

  // Cold anchors belong to one composing session: a run that matched
  // nothing must not suppress `#` in the next message.
  useEffect(() => {
    if (draft.trim().length > 0) return;
    setColdHashAnchors((current) => (current.size === 0 ? current : new Set()));
  }, [draft]);

  // A dismissal belongs to the trigger it was made against. Without this
  // it outlives that trigger and silently suppresses a later popover the
  // operator never dismissed.
  useEffect(() => {
    if (!dismissedKey) return;
    if (!dismissKey || dismissKey !== dismissedKey) setDismissedKey(undefined);
  }, [dismissKey, dismissedKey]);

  // The highlight belongs to one query. Resetting it here rather than in
  // `handleChange` is deliberate: the editor re-emits unchanged content on
  // caret moves, and resetting there sent every arrow key straight back to
  // the first row.
  useEffect(() => {
    setActiveIndex(0);
  }, [dismissKey]);

  // The popover deliberately survives a blur — clicking into the card's
  // transcript to check something should not throw away a half-typed
  // mention. But the editor's key handler is then out of the loop, so
  // without a window-scope listener Escape stops closing the popover and
  // it sits over the transcript with no way out but editing the draft.
  useEffect(() => {
    if (!open) return;
    const dismissOnEscape = (event: globalThis.KeyboardEvent): void => {
      // Already handled by the editor path, which prevents the default.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setDismissedKey(dismissKey);
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [dismissKey, open]);

  useEffect(() => {
    if (!open) return;
    // Optional call, not decoration: jsdom does not implement it, so an
    // unguarded call takes down every renderer test that opens a popover.
    optionRefs.current[activeOption]?.scrollIntoView?.({ block: "nearest" });
  }, [activeOption, open]);

  const handleChange = (
    nextDraft: string,
    nextSkillTokens?: ComposerSkillToken[],
  ): void => {
    const pending = pendingProgrammaticChangeRef.current;
    if (pending && nextSkillTokens) {
      if (
        nextDraft === pending.staleDraft
        && getComposerSkillTokensSignature(nextSkillTokens)
          === pending.staleSkillTokensSignature
      ) {
        return;
      }
      pendingProgrammaticChangeRef.current = undefined;
    }
    // Bail on an unchanged emit rather than committing an equal-but-new
    // object. The editor re-emits its current content on transactions that
    // changed nothing the composer cares about — a caret move is enough —
    // and each of those would otherwise hand `ComposerTiptapInput` a fresh
    // `skillTokens` identity and make it re-sync its whole document.
    setContent((current) => {
      const tokens = nextSkillTokens ?? current.skillTokens;
      if (
        current.draft === nextDraft
        && (tokens === current.skillTokens
          || getComposerSkillTokensSignature(tokens)
            === getComposerSkillTokensSignature(current.skillTokens))
      ) {
        return current;
      }
      return { draft: nextDraft, skillTokens: tokens };
    });
  };

  /**
   * Replace an autocomplete trigger with a mention chip.
   *
   * The chip is zero-width in the plain draft, so the trigger text is
   * removed and a token minted at that offset instead. Always leave one
   * space after the chip — including at the end of the draft — and park
   * the caret after it, so typing straight on cannot glue onto the chip's
   * serialized markdown.
   */
  const insertToken = (
    trigger: { end: number; start: number },
    createToken: (index: number) => ComposerSkillToken,
  ): void => {
    const input = inputRef.current;
    if (!input) return;

    const caret = Math.min(input.selectionStart ?? draft.length, draft.length);
    const selectionEnd = Math.min(input.selectionEnd ?? caret, draft.length);
    const before = draft.slice(0, trigger.start);
    const after = draft.slice(Math.max(trigger.end, selectionEnd));
    const nextAfter = /^\s/.test(after) ? after : ` ${after}`;
    const nextDraft = `${before}${nextAfter}`;
    const tokenIndex = before.length;
    const nextSelection = tokenIndex + 1;
    const nextSkillTokens = [
      ...adjustSkillTokenIndexesForTextChange({
        currentDraft: draft,
        nextDraft,
        skillTokens,
      }),
      createToken(tokenIndex),
    ];

    pendingProgrammaticChangeRef.current = {
      staleDraft: draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(skillTokens),
    };
    flushSync(() => {
      setContent({ draft: nextDraft, skillTokens: nextSkillTokens });
      setActiveIndex(0);
    });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  };

  const commit = (index: number): void => {
    if (kind === "skills" && skillTrigger) {
      const skill = skillOptions[index] ?? skillOptions[0];
      if (skill) {
        insertToken(skillTrigger, (at) => createComposerSkillToken(skill, at));
      }
      return;
    }
    if (kind === "directories" && directoryTrigger) {
      const directory = directoryOptions[index] ?? directoryOptions[0];
      if (directory?.path) {
        insertToken(directoryTrigger, (at) =>
          createComposerDirectoryToken(directory, at),
        );
      }
      return;
    }
    if (kind === "hash" && hashTrigger) {
      const option = hashOptions[index] ?? hashOptions[0];
      if (!option) return;
      insertToken(hashTrigger, (at) =>
        option.kind === "thread"
          ? createComposerThreadToken(
              resolveThreadSummaryReference(option.thread),
              at,
            )
          : createComposerPullRequestToken(option.pullRequest, at),
      );
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (!open || optionCount === 0 || event.defaultPrevented) return false;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(activeOption + 1, optionCount - 1));
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(activeOption - 1, 0));
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Stop here as well: the star map layer's own Escape handler sits on
      // an ancestor and clears the operator's gathered card selection.
      // Closing a popover is not also a request to drop that selection.
      event.stopPropagation();
      setDismissedKey(dismissKey);
      return true;
    }
    if (
      (event.key === "Enter" && !event.shiftKey && !event.altKey)
      || (event.key === "Tab" && !event.shiftKey)
    ) {
      event.preventDefault();
      commit(activeOption);
      return true;
    }
    return false;
  };

  const optionId = (index: number): string => `${listboxId}-option-${index}`;

  const renderOption = (index: number, content: ReactNode, extra?: {
    title?: string;
  }): ReactNode => (
    <button
      aria-selected={index === activeOption}
      className={`compact-composer__mention-option${
        index === activeOption ? " is-active" : ""
      }`}
      id={optionId(index)}
      key={optionId(index)}
      ref={(node) => {
        optionRefs.current[index] = node;
      }}
      role="option"
      tabIndex={-1}
      title={extra?.title}
      type="button"
      // `mousedown` default would blur the editor before the click lands,
      // and the trigger offsets are resolved against a live caret.
      onMouseDown={(event) => {
        event.preventDefault();
        commit(index);
      }}
      onClick={() => commit(index)}
    >
      {content}
    </button>
  );

  let options: ReactNode = null;
  let label = "";
  if (kind === "skills") {
    label = "Skills";
    options = skillOptions.map((skill, index) =>
      renderOption(
        index,
        <>
          <span className="compact-composer__mention-title">
            <HighlightedAutocompleteLabel
              label={`$${skill.name}`}
              query={query ? `$${query}` : "$"}
            />
          </span>
          <span className="compact-composer__mention-meta">
            {skill.shortDescription || skill.description || skill.path}
          </span>
        </>,
        { title: buildSkillTooltip(skill) || undefined },
      ),
    );
  } else if (kind === "directories") {
    label = "Directories";
    options = directoryOptions.map((directory, index) =>
      renderOption(
        index,
        <>
          <span className="compact-composer__mention-title">
            <FolderIcon size={12} aria-hidden="true" />
            <HighlightedAutocompleteLabel
              label={directory.label}
              query={query}
            />
          </span>
          <span className="compact-composer__mention-meta">
            {buildDirectoryReferenceInsertText(directory)}
          </span>
        </>,
      ),
    );
  } else if (kind === "hash") {
    label = "Threads and pull requests";
    options = hashOptions.map((option, index) => {
      if (option.kind === "thread") {
        const thread = option.thread;
        const meta = describeHashReferenceThread(thread, query);
        return renderOption(
          index,
          <>
            <span className="compact-composer__mention-title">
              <ThreadIcon size={12} aria-hidden="true" />
              <HighlightedAutocompleteLabel
                label={`#${formatHashReferenceThreadLabel(thread).replace(/^#/, "")}`}
                matchAnywhere
                query={query.trim()}
              />
            </span>
            {/* The full composer separates peer rows with an "Other
                instances" divider and an instance chip. Two rows fit in a
                card's popover, so the instance rides in the meta line
                instead of spending one of them on a heading. */}
            <span className="compact-composer__mention-meta">
              {option.remote && thread.federation?.instanceLabel
                ? `${thread.federation.instanceLabel}${meta ? ` · ${meta}` : ""}`
                : meta}
            </span>
          </>,
          { title: formatHashReferenceThreadTooltip(thread) },
        );
      }
      const pullRequest = option.pullRequest;
      return renderOption(
        index,
        <>
          <span className="compact-composer__mention-title">
            <PullRequestIcon size={12} aria-hidden="true" />
            <HighlightedAutocompleteLabel
              label={`#${pullRequest.number}`}
              matchAnywhere
              query={query.trim()}
            />
          </span>
          <span className="compact-composer__mention-meta">
            {`${pullRequest.org}/${pullRequest.repo} · ${pullRequest.title}`}
          </span>
        </>,
        { title: pullRequest.title },
      );
    });
  }

  // Rebuilt every render, so a shrinking list cannot leave a scroll target
  // pointing at a row that is gone.
  optionRefs.current.length = optionCount;

  const popover = open ? (
    <div
      aria-label={label}
      className="compact-composer__mention-list"
      id={listboxId}
      role="listbox"
    >
      {options}
    </div>
  ) : null;

  return {
    activeOptionId: open ? optionId(activeOption) : undefined,
    clear: () => {
      pendingProgrammaticChangeRef.current = undefined;
      setContent({ draft: "", skillTokens: [] });
      setActiveIndex(0);
      setDismissedKey(undefined);
    },
    draft,
    handleChange,
    handleKeyDown,
    inputRef,
    listboxId: open ? listboxId : undefined,
    open,
    popover,
    restore: (previous) => {
      // Only if the operator has not started something new in the meantime;
      // their fresh text outranks a bounced message.
      setContent((current) =>
        current.draft.length > 0 || current.skillTokens.length > 0
          ? current
          : previous,
      );
    },
    skillTokens,
    snapshot: content,
    text: serializeDraftWithSkillTokens(draft, skillTokens),
  };
}
