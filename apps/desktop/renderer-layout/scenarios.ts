import fc from "fast-check";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { DESKTOP_APPEARANCE_DENSITIES, type DesktopAppearanceDensity } from "@pwragent/shared/contracts/settings";

const lenses = ["directories", "inbox", "recents", "attention", "drafts"] as const;
const densities = DESKTOP_APPEARANCE_DENSITIES;

export type LayoutScenario = {
  lens: typeof lenses[number];
  density: DesktopAppearanceDensity;
  theme: "light" | "dark";
  sidebarWidth: number;
  railWidth: number;
  pickerWidth: number;
  transcriptWidth: number;
  directoryLabel: string;
  threads: Array<{
    title: string;
    prs: PrSummary[];
    pinned: boolean;
    stacked: boolean;
    workerTitle?: string;
  }>;
};

const longTitle = "Refresh the documentation site for the next release and update every settings page ".repeat(3).trim();
const text = fc.tuple(
  fc.constantFrom(
    "Fix",
    longTitle,
    "SupercalifragilisticNavigationLayerRefactorWithoutAnySpacesAtAll",
    "東京のサーバーでナビゲーションを修正する長いタイトル",
    "تحديث الوثائق الخاصة بالإصدار الجديد من التطبيق",
    "🚀 Launch 👩🏽‍💻 the docs",
    "no\u00a0break\u00a0spaces\u00a0between\u00a0these\u00a0words",
    "feature/very-long-branch-name-without-any-spaces",
  ),
  fc.integer({ min: 1, max: 3 }),
).map(([value, repeats]) => value.repeat(repeats));

// Forge names have a different input space from titles. Keep the lead PR in
// the workspace's repository, with long names on the attached PRs.
const repositoryName = fc.constantFrom(
  "tools",
  "another-repository-with-a-long-name-and-many-parts",
  "NavigationLayerRefactorWithoutAnySpacesAtAll",
);
const prFields = fc.record({
  number: fc.constantFrom(7, 634, 4618, 123456789),
  title: text,
  state: fc.constantFrom("passing", "pending", "failing", "unknown"),
  mergeQueue: fc.option(fc.record({
    kind: fc.constant("merge_queue"),
    state: fc.constantFrom("queued", "group_checks_running", "merging"),
    position: fc.constantFrom(1, 12, 345),
  }), { nil: undefined }),
}) satisfies fc.Arbitrary<Partial<PrSummary> & { number: number }>;

function makePr(fields: Partial<PrSummary> & { number: number }, org = "example", repo = "project"): PrSummary {
  return {
    provider: "github.com",
    state: "unknown",
    lifecycleState: "open",
    ...fields,
    org,
    repo,
    url: `https://github.com/${org}/${repo}/pull/${fields.number}`,
  };
}

const generatedThread = fc.record({
  title: text,
  lead: prFields,
  attached: fc.array(fc.tuple(prFields, repositoryName), { minLength: 1, maxLength: 3 }),
  pinned: fc.boolean(),
  stacked: fc.boolean(),
  workerTitle: fc.option(text, { nil: undefined }),
}).map(({ title, lead, attached, pinned, stacked, workerTitle }) => ({
  title,
  prs: [
    makePr(lead),
    ...attached.map(([pr, repo], index) => makePr({ ...pr, explicitlyAttached: true }, `long-organization-name-${index}`, repo)),
  ],
  pinned,
  stacked,
  workerTitle,
}));

export function generatedLayouts(seed: number) {
  // Keep one case per lens and cover every density and both schemes in
  // each run. The seed rotates which lens gets which density and scheme.
  const offset = seed >>> 0;
  return fc.sample(fc.record({
    sidebarWidth: fc.constantFrom(280, 300, 340, 408, 480, 560),
    railWidth: fc.integer({ min: 240, max: 640 }),
    pickerWidth: fc.integer({ min: 240, max: 560 }),
    transcriptWidth: fc.integer({ min: 240, max: 900 }),
    directoryLabel: text,
    threads: fc.array(generatedThread, { minLength: 2, maxLength: 5 }),
  }), { seed, numRuns: lenses.length }).map((sample, index) => ({
    name: `fast-check seed ${seed}, case ${index + 1} (${lenses[index]})`,
    scenario: {
      ...sample,
      lens: lenses[index],
      density: densities[(offset + index) % densities.length],
      theme: (offset + index) % 2 === 0 ? "dark" : "light",
    } satisfies LayoutScenario,
  }));
}

const narrowLayout: LayoutScenario = {
  lens: "inbox",
  density: "mission-control",
  theme: "dark",
  sidebarWidth: 280,
  railWidth: 240,
  pickerWidth: 240,
  transcriptWidth: 240,
  directoryLabel: "Project",
  threads: [],
};

export const regressionLayouts: Array<{ name: string; scenario: LayoutScenario }> = [
  {
    name: "a long Details title leaves all three digits of #634 visible",
    scenario: {
      ...narrowLayout,
      railWidth: 440,
      threads: [{
        title: "Update the docs",
        prs: [makePr({ number: 634, title: longTitle })],
        pinned: false,
        stacked: false,
      }],
    },
  },
  {
    name: "a nine-digit queued PR leaves room for Auto-fix at the 240px rail floor",
    scenario: {
      ...narrowLayout,
      threads: [{
        title: "Update the docs",
        prs: [makePr({
          number: 123456789,
          title: longTitle,
          mergeQueue: { kind: "merge_queue", state: "queued", position: 12 },
        })],
        pinned: false,
        stacked: false,
      }],
    },
  },
  {
    name: "an expanded worker with a long worktree path fits its sidebar lane",
    scenario: {
      ...narrowLayout,
      sidebarWidth: 340,
      threads: [{
        title: "Update the docs",
        prs: [
          makePr({ number: 634, title: "Update the docs" }),
          makePr({ number: 123456789, title: "Refresh links", explicitlyAttached: true },
            "long-organization-name", "docs-navigation-refactor-with-a-long-repository-name"),
        ],
        pinned: false,
        stacked: true,
        workerTitle: "Run cd /projects/worktrees/docs-refresh-and-navigation-layer-refactor/documentation-site && grep -n 'coming-soon' providers/*.md",
      }],
    },
  },
];
