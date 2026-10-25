import { useMemo, useRef, type KeyboardEvent } from "react";
import type {
  DesktopAppearanceDensity,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import { ThreadRow } from "../navigation/ThreadRow";
import { ThreadRowDensityContext } from "../navigation/thread-row-density";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { xrayKeyLabel } from "../../lib/xray-mode";

type DensityChoice = {
  value: DesktopAppearanceDensity;
  label: string;
  title: string;
  desc: (key: string) => string;
  hint: string;
};

export const DENSITY_CHOICES: readonly DensityChoice[] = [
  {
    value: "mission-control",
    label: "Mission control",
    title: "Every signal on every row",
    desc: () =>
      "Provider, worktree, branch, every pull request, uncommitted changes, and reactions ride on each row. Nothing to remember, because it is all on screen.",
    hint: "Best for: scanning many parallel threads at a glance.",
  },
  {
    value: "compact",
    label: "Compact",
    title: "Pull requests and reactions only",
    desc: (key) =>
      `Hides the provider, worktree, and branch chips. Pull requests, reactions, and anything waiting on you stay. Hold ${key} to x-ray the rest.`,
    hint: "Best for: knowing where each thread lives.",
  },
  {
    value: "minimal",
    label: "Minimal",
    title: "One line per thread",
    desc: (key) =>
      `The title, one chip for all of a thread's pull requests showing the one that needs you most, and anything waiting on you. Hold ${key} to x-ray every chip; press ${key} twice to keep them showing.`,
    hint: "Best for: long thread lists and small windows.",
  },
];

export function densityLabel(value: DesktopAppearanceDensity): string {
  return DENSITY_CHOICES.find((choice) => choice.value === value)?.label ?? value;
}

/**
 * The density choice as three cards, each previewing the same threads with
 * the real `ThreadRow`, so a preview cannot fall behind the list it shows.
 * Each preview sets its own density (`.density-preview--*` in app.css)
 * whatever the app's density is, and is `inert`: the card's radio is the only
 * control. Settings uses the short cards; onboarding adds the descriptions.
 */
export function DensityPicker(props: {
  value: DesktopAppearanceDensity;
  onChange: (value: DesktopAppearanceDensity) => void;
  variant: "settings" | "wizard";
  platform: string | undefined;
}) {
  const radiosRef = useRef<Array<HTMLButtonElement | null>>([]);
  const threads = useMemo(() => buildPreviewThreads(Date.now()), []);
  const key = xrayKeyLabel(props.platform);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + DENSITY_CHOICES.length) % DENSITY_CHOICES.length;
    props.onChange(DENSITY_CHOICES[next]!.value);
    radiosRef.current[next]?.focus();
  };

  return (
    <div
      aria-label="Info density"
      className={`density-picker density-picker--${props.variant}`}
      role="radiogroup"
    >
      {DENSITY_CHOICES.map((choice, index) => {
        const selected = props.value === choice.value;
        return (
          <div
            key={choice.value}
            className={`density-picker__card${selected ? " is-selected" : ""}`}
          >
            <button
              ref={(node) => {
                radiosRef.current[index] = node;
              }}
              aria-checked={selected}
              className="density-picker__choose"
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
              onClick={() => props.onChange(choice.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="density-picker__eyebrow">{choice.label}</span>
              <span className="density-picker__title">{choice.title}</span>
            </button>
            {selected ? (
              <span aria-hidden="true" className="density-picker__badge">
                Selected
              </span>
            ) : null}
            <div
              aria-hidden="true"
              className={`density-picker__preview density-preview density-preview--${choice.value}`}
              inert
            >
              <ThreadRowDensityContext.Provider value={choice.value}>
                {threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    draftThreadKeys={PREVIEW_DRAFT_KEYS}
                    includeLinkedDirectories
                    linkedDirectoryMode="kind"
                    thread={thread}
                    onOpenContextMenu={noop}
                    onSelectThread={noop}
                  />
                ))}
              </ThreadRowDensityContext.Provider>
            </div>
            {props.variant === "wizard" ? (
              <>
                <p className="density-picker__desc">{choice.desc(key)}</p>
                <p className="density-picker__hint">{choice.hint}</p>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function noop(): void {}

const PREVIEW_DRAFT_THREAD_ID = "density-preview-pdf";
// Keyed the way ThreadRow looks threads up, so the Draft chip shows.
const PREVIEW_DRAFT_KEYS = {
  [threadSummaryIdentityKey({ id: PREVIEW_DRAFT_THREAD_ID, source: "codex" })]: true,
};

function previewPr(number: number, extra: Partial<PrSummary>): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    ...extra,
  };
}

/** Contrived threads that exercise each density's rules. */
function buildPreviewThreads(now: number): NavigationThreadSummary[] {
  const minutesAgo = (minutes: number) => now - minutes * 60_000;
  const worktree = {
    id: "density-preview-orbit-worktree",
    kind: "worktree" as const,
    label: "orbit",
    path: "/Users/you/src/orbit",
    worktreePath: "/Users/you/.pwragent/worktrees/preview/orbit",
  };
  const base = {
    titleSource: "explicit" as const,
    summary: "",
    source: "codex" as const,
    executionMode: "default" as const,
    inbox: { inInbox: false },
    linkedDirectories: [worktree],
  };
  return [
    {
      ...base,
      id: "density-preview-transport",
      title: "Split the transport crate into modules",
      updatedAt: minutesAgo(12),
      gitBranch: "feat/transport-modules",
      gitWorkingState: {
        dirtyFiles: 9,
        dirtyAdditions: 1284,
        dirtyDeletions: 311,
        untrackedFiles: 0,
        unpushedCommits: 0,
      },
      prs: [
        previewPr(4614, { checkState: "failing", state: "failing", checksStillRunning: true }),
        previewPr(4618, { checkState: "pending", state: "pending" }),
        previewPr(4601, { lifecycleState: "merged", state: "merged" }),
      ],
    },
    {
      ...base,
      id: "density-preview-release",
      title: "Release checklist",
      updatedAt: minutesAgo(130),
      gitBranch: "main",
      linkedDirectories: [{ ...worktree, id: "density-preview-orbit-local", kind: "local" }],
      pinnedRank: "a0",
    },
    {
      ...base,
      id: "density-preview-scheduler",
      title: "Automation scheduling",
      updatedAt: minutesAgo(2 * 24 * 60),
      gitBranch: "feat/scheduler",
      prs: [
        previewPr(4620, {}),
        previewPr(4613, { mergeState: "conflicting" }),
      ],
      reactions: ["🏃"],
    },
    {
      ...base,
      id: PREVIEW_DRAFT_THREAD_ID,
      title: "Pass PDFs through directly",
      updatedAt: minutesAgo(3 * 24 * 60),
      gitBranch: "feat/pdf-passthrough",
      prs: [previewPr(4621, { reviewState: "draft" })],
    },
  ] as NavigationThreadSummary[];
}
