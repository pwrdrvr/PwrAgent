import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CODEX_NATIVE_SUBAGENT_MONITOR_ID_PREFIX } from "@pwragent/shared/subagent-kind";
import { buildPullRequestStatusKey, type NavigationDirectorySummary, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import "../src/renderer/src/styles/app.css";
import { FixtureSidebar } from "../src/renderer/src/test/navigation-presentation-fixture";
import { ThreadRowDensityContext } from "../src/renderer/src/features/navigation/thread-row-density";
import { threadSummaryIdentityKey } from "../src/renderer/src/lib/federated-thread-events";
import { applySubAgentActivityEvent, resetSubAgentActivityStore } from "../src/renderer/src/lib/sub-agent-activity";
import { DetailsFoldersSection } from "../src/renderer/src/features/thread-detail/context-panels/DetailsFoldersSection";
import { DetailsAutoFixButton } from "../src/renderer/src/features/thread-detail/context-panels/DetailsAutoFixButton";
import { PullRequestsPanel } from "../src/renderer/src/features/thread-detail/context-panels/PullRequestsPanel";
import { ThreadMarkdown } from "../src/renderer/src/features/thread-detail/ThreadMarkdown";
import { ReviewPullRequestPicker } from "../src/renderer/src/features/composer/ReviewPullRequestPicker";
import { PullRequestLinkProvider } from "../src/renderer/src/lib/pull-request-links";
import { stackRepository } from "../src/renderer/src/features/stacks/stack-pr-data";
import type { ComponentProps, CSSProperties } from "react";
import type { LayoutScenario } from "./scenarios";
import { measureLayout } from "./layout-oracles";

declare global {
  interface Window {
    checkRendererLayout(scenario: LayoutScenario): Promise<ReturnType<typeof measureLayout>>;
  }
}

const now = 1_795_700_000_000;
const repository = "github.com/example/project";
const root = createRoot(document.getElementById("root")!);
let caseId = 0;

// The PR panel feature-detects detach. Supply that capability so an attached
// PR uses the same split chip as in the app.
const prPanelApi: ComponentProps<typeof PullRequestsPanel>["desktopApi"] = {
  detachThreadPullRequest: async () => {
    throw new Error("The layout fixture does not detach pull requests");
  },
};

const noop = () => undefined;
const noopAsync = async () => undefined;
const surfaceStyle = (width: number): CSSProperties => ({ width, overflow: "hidden", flex: "none" });

window.checkRendererLayout = async (scenario) => {
  const html = document.documentElement;
  html.dataset.platform = "linux";
  html.dataset.theme = scenario.theme;
  html.dataset.density = scenario.density;

  const { threads, keys, directory } = buildNavigation(scenario);
  const thread = threads[0];
  const prs = thread.prs ?? [];
  const shellStyle = { "--sidebar-width": `${scenario.sidebarWidth}px`, height: "100vh" } as CSSProperties;

  resetSubAgentActivityStore();
  for (const parent of threads) {
    if (!parent.codexNativeSubAgents?.length) continue;
    applySubAgentActivityEvent({
      backend: parent.source,
      notification: {
        method: "thread/subAgentActivity/updated",
        params: {
          threadId: parent.id,
          activities: parent.codexNativeSubAgents.map(({ threadId, title }) => ({
            monitorId: `${CODEX_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}${threadId}`,
            activity: `Reading /projects/worktrees/docs-refresh/${title}`,
          })),
        },
      },
    });
  }

  // Measure the committed tree with its final font metrics. The browser and
  // React root are shared across cases. The key resets component-local state.
  flushSync(() => root.render(
    <div className="app-shell" key={caseId++} style={shellStyle}>
      <div data-surface="sidebar" style={{ display: "contents" }}>
        <ThreadRowDensityContext.Provider value={scenario.density}>
          <FixtureSidebar
            backends={[]}
            browseMode={scenario.lens}
            directories={[directory]}
            threads={threads}
            loading={false}
            selectedItemKey={keys[0]}
            draftThreadKeys={Object.fromEntries(keys.map((key) => [key, true]))}
            onBrowseModeChange={noop}
            onCreateThread={noopAsync}
            onOpenLaunchpad={noopAsync}
            onSelectThread={noop}
          />
        </ThreadRowDensityContext.Provider>
      </div>
      <main className="app-main" style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
        <div data-surface="details" style={surfaceStyle(scenario.railWidth)}>
          <DetailsFoldersSection
            thread={thread}
            showTooltip={noop}
            hideTooltip={noop}
            onShowChanges={noop}
            onShowPullRequests={noop}
            autoFix={<DetailsAutoFixButton thread={thread} settings={{}} />}
          />
        </div>
        <div data-surface="prs-panel" className="context-panel" style={surfaceStyle(scenario.railWidth)}>
          <PullRequestsPanel thread={thread} desktopApi={prPanelApi} />
        </div>
        <div data-surface="review-picker" className="composer__review-field" style={surfaceStyle(scenario.pickerWidth)}>
          <ReviewPullRequestPicker
            prs={prs}
            selectedUrls={prs.slice(0, 1).map((pr) => pr.url)}
            multiple
            repositoryLabel={(pr) => `${pr.org}/${pr.repo}`}
            onChange={noop}
          />
        </div>
        <div data-surface="transcript" className="message-body" style={surfaceStyle(scenario.transcriptWidth)}>
          <PullRequestLinkProvider threads={threads} activeThread={thread}>
            <ThreadMarkdown text={`Review ${prs.map((pr) => `[PR #${pr.number}](${pr.url})`).join(" ")} today.`} />
          </PullRequestLinkProvider>
        </div>
      </main>
    </div>,
  ));
  flushSync(() => {
    for (const toggle of document.querySelectorAll<HTMLButtonElement>("aside.sidebar .native-subagents__toggle:not(.is-open)")) {
      toggle.click();
    }
  });
  // Flush layout before awaiting font readiness: a new case may use a face
  // or weight that the previous one did not request.
  document.body.getBoundingClientRect();
  await document.fonts.ready;
  return measureLayout();
};

function buildNavigation(scenario: LayoutScenario) {
  const path = "/projects/example/project";
  const threads = scenario.threads.map<NavigationThreadSummary>(({ title, prs, pinned, stacked, workerTitle }, index) => ({
    id: `thread-${index}`,
    title,
    titleSource: "explicit",
    source: "codex",
    threadStatus: index % 2 === 0 ? "active" : "idle",
    createdAt: now - index * 60_000,
    updatedAt: now - index * 30_000,
    inbox: { inInbox: true, reason: "updated-since-seen" },
    linkedDirectories: [{ id: "directory", label: scenario.directoryLabel, path, kind: "local" }],
    gitBranch: "feature/update-docs",
    primaryGitRepository: repository,
    ...(pinned ? { pinnedRank: String(index + 1) } : {}),
    ...(workerTitle ? {
      codexNativeSubAgents: [{ threadId: `worker-${index}`, title: workerTitle, threadStatus: "active" }],
      nativeSubAgentCount: 1,
      nativeSubAgentGroupPresent: true,
      hasActiveSubAgent: true,
    } : {}),
    ...(stacked ? {
      stackLeadPrKey: buildPullRequestStatusKey(prs[1]),
      stackMemberships: [{
        key: `stack-${index}`,
        name: title,
        inferred: false,
        position: 2,
        count: 2,
        repository: stackRepository(prs[1]),
        number: prs[1].number,
        health: "needs_restack",
        hasOpenPr: true,
        trunk: "main",
      }],
    } : {}),
    prs,
  }));
  const keys = threads.map(threadSummaryIdentityKey);
  const directory: NavigationDirectorySummary = {
    key: `directory:${path}`,
    kind: "directory",
    label: scenario.directoryLabel,
    path,
    threadKeys: keys,
    needsAttentionCount: keys.length,
    latestUpdatedAt: now,
  };
  return { threads, keys, directory };
}
