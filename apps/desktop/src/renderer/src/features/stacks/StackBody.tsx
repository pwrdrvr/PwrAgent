import { createContext, useContext, type ComponentProps } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { StackLayer, StackSummary } from "@pwragent/shared/stacks/stack-status";
import { ThreadIcon } from "../../icons";
import { prStackTimeLabel } from "../pr-status/pr-rollup";
import { isPrStatusUnknown, prStatusLabel, resolveLifecycleState, resolvePrChipPresentation } from "../pr-status/pr-chip-state";
import { knownPrStatus, stackHealthLabel, stackLayerReadiness, stackRepository, stackThreadKey, staleStackSpine } from "./stack-pr-data";

export const StackNavigationContext = createContext<{
  findThread: (owner: NavigationThreadSummary, key: string) => NavigationThreadSummary | undefined;
  openThread: (owner: NavigationThreadSummary, key: string) => void;
} | undefined>(undefined);

export function StackGlyph(props: ComponentProps<"svg">) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props} aria-hidden="true">
      <path d="m2 5.5 6-3.5 6 3.5L8 9 2 5.5Zm0 3.2 6 3.5 6-3.5M2 12l6 3.5 6-3.5" />
    </svg>
  );
}

export function StackHeading({ count, trunk, inferred, grouped }: {
  count: number;
  trunk?: string;
  inferred: boolean;
  grouped?: boolean;
}) {
  return (
    <div className="stack-display__head">
      <span className="stack-display__caption"><StackGlyph /> Stack</span>
      <span className="stack-display__summary" title={trunk}>
        {grouped ? `· ${count}` : `${count} PRs`}{trunk ? ` into ${trunk}` : ""}
      </span>
      {!grouped ? <span className="stack-display__source">{inferred ? "from PR bases" : "gh stack"}</span> : null}
    </div>
  );
}

export function StackNode({ pr, kind }: { pr?: PrSummary; kind?: "trunk" | "branch" }) {
  const presentation = pr && resolvePrChipPresentation(pr);
  const tone = kind ?? (presentation?.isConflicting ? "conflicting" : presentation?.chipState ?? "unknown");
  return <span className="stack-display__node" data-tone={tone} aria-hidden="true" />;
}

export function StackLayerMeta({ prefix, pr, status, health, className = "stack-display__status" }: {
  prefix: string;
  pr?: PrSummary;
  status?: string;
  health?: string;
  className?: string;
}) {
  const readiness = stackLayerReadiness(pr, status, health);
  const lead = readiness ? `${prefix} · ${readiness}` : prefix;
  return (
    <span className={className}>
      {lead}
      {health ? <> · <span className="stack-display__warning">{health}</span></> : null}
    </span>
  );
}

export function StackTrunk({ trunk }: { trunk: string }) {
  return (
    <li className="stack-display__trunk" title={trunk}>
      <StackNode kind="trunk" />
      <span>{trunk}</span>
    </li>
  );
}

/** Only the matching repository's PR can supply the layer's live snapshot. */
function readLayerPr(stack: StackSummary, layer: StackLayer, candidates: readonly PrSummary[]) {
  const snapshot = layer.pullRequest;
  if (!snapshot) return undefined;
  const live = candidates.find((pr) => pr.number === snapshot.number && stackRepository(pr) === stack.repository);
  if (live && (!isPrStatusUnknown(live) || !snapshot.lifecycleState)) return live;
  const [provider, repository] = stack.repository.split(":");
  const [org, repo] = repository?.split("/") ?? [];
  if (!provider || !org || !repo) return undefined;
  return {
    ...snapshot, provider, org, repo, state: snapshot.state ?? "unknown",
    title: live?.title ?? snapshot.title,
    url: live?.url ?? snapshot.url ?? (provider === "github.com" ? `https://github.com/${org}/${repo}/pull/${snapshot.number}` : ""),
  } satisfies PrSummary;
}

function layerStatus(pr: PrSummary | undefined) {
  if (!pr) return undefined;
  if (resolveLifecycleState(pr) === "merged") return prStackTimeLabel(pr) ?? "merged";
  return knownPrStatus(prStatusLabel(pr));
}

export function StackBody({ stack, thread, position, onOpen, onThreadOpen }: {
  stack: StackSummary;
  thread: NavigationThreadSummary;
  /** Set for one PR's popover, absent when the rail marks every attached layer. */
  position?: number;
  onOpen: (url: string) => void;
  onThreadOpen?: () => void;
}) {
  const navigation = useContext(StackNavigationContext);
  const thisThreadKey = stackThreadKey(thread);
  return (
    <>
      <StackHeading count={stack.layers.length} trunk={stack.trunk} inferred={stack.inferred} />
      <ol className="stack-display__list" reversed>
        {stack.layers.toReversed().map((layer, index) => {
          const layerPosition = stack.layers.length - index;
          const other = layer.thread?.key !== thisThreadKey ? layer.thread : undefined;
          const owner = other && navigation?.findThread(thread, other.key);
          const current = position === undefined
            ? layer.thread?.key === thisThreadKey || thread.prs?.some((pr) =>
              pr.number === layer.pullRequest?.number && stackRepository(pr) === stack.repository)
            : layerPosition === position;
          const pr = readLayerPr(stack, layer, [...(owner?.prs ?? []), ...(thread.prs ?? [])]);
          const title = pr?.title?.trim() || layer.pullRequest?.title?.trim() || layer.branch;
          const prefix = layer.pullRequest ? `#${layer.pullRequest.number}` : "no PR yet";
          const health = stackHealthLabel(layer);
          const url = pr?.url;
          return (
            <li key={layerPosition} className="stack-display__layer" data-position={layerPosition}
              data-stale={staleStackSpine(layer.health) || undefined} data-current={current || undefined}>
              <StackNode pr={pr} kind={layer.pullRequest ? undefined : "branch"} />
              <div className="stack-display__text">
                {url ? (
                  <button type="button" className="stack-display__title stack-display__open" title={title}
                    onClick={() => onOpen(url)}>
                    {title}
                  </button>
                ) : <span className="stack-display__title" title={title}>{title}</span>}
                <StackLayerMeta prefix={prefix} pr={pr} status={layerStatus(pr)} health={health} />
                {other && navigation ? (
                  <button type="button" className="stack-display__thread" title={owner?.title ?? other.title}
                    onClick={() => {
                      onThreadOpen?.();
                      navigation.openThread(thread, other.key);
                    }}>
                    <ThreadIcon size={11} /> <span>{owner?.title ?? other.title}</span>
                  </button>
                ) : null}
              </div>
              <div className="stack-display__position">
                {current && position !== undefined ? <span className="stack-display__current">This PR</span> : null}
                {layerPosition}/{stack.layers.length}
              </div>
            </li>
          );
        })}
        <StackTrunk trunk={stack.trunk} />
      </ol>
    </>
  );
}

export function StackRailCard(props: Omit<ComponentProps<typeof StackBody>, "position">) {
  return <li className="rail-card stack-rail-card"><StackBody {...props} /></li>;
}
