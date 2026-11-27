import { memo, useEffect, useMemo } from "react";
import type { BackendRuntimeBuild, BackendSummary } from "@pwragent/shared/contracts/backend";
import { usageLimitProviderForBackend } from "@pwragent/shared/contracts/usage-activity";
import { PopoutIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  describeRateLimitRow,
  formatBackendAccountText,
  formatBackendPlanType,
  isCreditsRateLimit,
  selectVisibleRateLimits,
  type BackendRateLimitSummary,
} from "../../../lib/backend-status-format";
import {
  groupRateLimitsByScope,
  UNSCOPED_RATE_LIMIT_LABEL,
  type RateLimitScopeGroup,
} from "../../../lib/rate-limit-scopes";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import { claudeProviderStatus } from "../../settings/claude-provider-status";
import {
  useLocalUsagePace,
  usagePaceAccountKey,
  usagePaceRefreshKey,
} from "../../federation-activity/useLocalUsagePace";
import type { LimitAccount } from "../../federation-activity/usage-limits";
import { ProviderLimitRow, ProviderLimitScopes } from "./ProviderLimitRow";

type ProviderStatusPanelProps = {
  backends: BackendSummary[];
  backendError?: string;
  desktopApi?: Pick<DesktopApi, "openUsageActivity" | "readUsageActivity">;
};

/**
 * AI Provider Info tab — availability, runtime, authentication, account,
 * plan, and rate-limit lines for every configured agent backend.
 *
 * Every provider's rows share one narrow label column: the list is one grid
 * and each provider a subgrid of it. Facts are label/value rows; limits are
 * their own block under them, grouped by scope and labelled by window, so the
 * label column fits "Version" rather than "Weekly Claude/GPT limit" and every
 * limit's meter runs the same width to the panel's edge.
 */
export const ProviderStatusPanel = memo(function ProviderStatusPanel(props: ProviderStatusPanelProps) {
  useEffect(() => {
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  }, []);
  const chartableBackends = props.backends.filter((backend) => backend.available
    && usageLimitProviderForBackend(backend.kind) && backend.rateLimits?.some((limit) => limit.usedPercent !== undefined));
  const pace = useLocalUsagePace(
    chartableBackends.length ? props.desktopApi?.readUsageActivity : undefined,
    usagePaceRefreshKey(chartableBackends),
    usagePaceAccountKey(chartableBackends),
  );
  // Reset times are relative to the backends' latest refresh, not each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [props.backends]);
  const openUsageActivity = props.desktopApi?.openUsageActivity;

  return (
    <section className="context-panel__section">
      <div className="provider-status__heading">
        <h3>AI providers</h3>
        {openUsageActivity ? (
          <button
            className="context-panel__section-action"
            onClick={() => void openUsageActivity()}
            type="button"
          >
            <PopoutIcon size={11} aria-hidden="true" />
            Usage Activity
          </button>
        ) : null}
      </div>
      {props.backendError ? (
        <p className="context-empty">{props.backendError}</p>
      ) : props.backends.length > 0 ? (
        <ul className="backend-status-list">
          {props.backends.map((backend) => (
            <li key={backend.kind} className="backend-status-list__item">
              <div className="backend-status-list__summary">
                <span
                  aria-hidden="true"
                  className={`backend-status-list__dot${
                    backend.available ? "" : " is-unavailable"
                  }`}
                />
                <span className="backend-status-list__name">{backend.label}</span>
                <span
                  className={`backend-status-list__state${
                    backend.available ? "" : " is-unavailable"
                  }`}
                >
                  {backend.available ? "Available" : unavailableLabel(backend)}
                </span>
              </div>
              {backend.available ? null : <UnavailableDetail backend={backend} />}
              {backend.available && hasProviderMetadata(backend) ? (
                <ProviderFacts
                  backend={backend}
                  now={now}
                  account={pace?.accounts.get(usageLimitProviderForBackend(backend.kind) ?? "")}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="context-empty">Status unavailable</p>
      )}
    </section>
  );
});

function ProviderFacts({ backend, now, account }: {
  backend: BackendSummary;
  now: number;
  account?: LimitAccount;
}) {
  const visible = selectVisibleRateLimits(backend);
  const credits = visible.find(isCreditsRateLimit);
  const scopes = panelLimitScopes(visible);
  const version = backendVersion(backend);
  const showsPlan = backend.kind === "codex" || Boolean(backend.account?.planType);
  return (
    <>
      <dl className="backend-status-list__metadata-grid">
        {version || backend.runtimeBuild ? (
          <div>
            <dt>Version</dt>
            <dd>
              {[version, backend.runtimeBuild ? formatRuntimeBuild(backend.runtimeBuild) : undefined]
                .filter(Boolean).join(" · ")}
            </dd>
          </div>
        ) : null}
        {backend.acp ? (
          <div>
            <dt>Auth</dt>
            <dd>{formatAcpAuthStatus(backend.acp.authStatus)}</dd>
          </div>
        ) : null}
        {backend.kind === "codex" || showsAccount(backend) ? (
          <div>
            <dt>Account</dt>
            <dd>{backend.account ? formatBackendAccountText(backend.account) : "Unavailable"}</dd>
          </div>
        ) : null}
        {showsPlan ? (
          <div>
            <dt>Plan</dt>
            <dd>
              {providerPlanText(backend)}
              {credits ? <> · <CreditsText credits={credits} now={now} /></> : null}
            </dd>
          </div>
        ) : credits ? (
          <div>
            <dt>Credits</dt>
            <dd><CreditsText credits={credits} now={now} /></dd>
          </div>
        ) : null}
      </dl>
      {scopes.length ? (
        <ProviderLimitScopes scopes={scopes}>
          {(scope) => scope.windows.map((entry) => (
            <ProviderLimitRow
              key={`${entry.limit.limitId ?? "limit"}:${entry.limit.name}`}
              entry={entry}
              now={now}
              account={account}
            />
          ))}
        </ProviderLimitScopes>
      ) : null}
    </>
  );
}

/**
 * The panel shows every limit a provider reports. The shared grouping leaves
 * out a limit with no window ("Included credits", "Extra usage", an
 * individual cap); those join the provider's unscoped allowance, named for
 * themselves. Credits are a balance and ride on the Plan line instead.
 */
function panelLimitScopes(limits: readonly BackendRateLimitSummary[]): RateLimitScopeGroup[] {
  const scopes = groupRateLimitsByScope(limits);
  const grouped = new Set(scopes.flatMap((scope) => scope.windows.map((entry) => entry.limit)));
  const rest = limits
    .filter((limit) => !grouped.has(limit) && !isCreditsRateLimit(limit))
    .map((limit) => ({ limit, window: { label: limitNameWithoutLimit(limit.name) } }));
  if (!rest.length) return scopes;
  const unscoped = scopes.find((scope) => scope.scope === null || scope.scope === UNSCOPED_RATE_LIMIT_LABEL);
  if (unscoped) {
    return scopes.map((scope) => (scope === unscoped ? { ...scope, windows: [...scope.windows, ...rest] } : scope));
  }
  return [...scopes, { scope: scopes.length ? UNSCOPED_RATE_LIMIT_LABEL : null, windows: rest }];
}

/** "Included credits" as is; "Individual limit" as "Individual". */
function limitNameWithoutLimit(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.toLowerCase() !== "limit");
  const label = words.join(" ");
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : name.trim();
}

/** The credit balance, worded to follow the plan on its line. */
function CreditsText({ credits, now }: { credits: BackendRateLimitSummary; now: number }) {
  const row = describeRateLimitRow(credits, now);
  if (row.figure) {
    return <><b className="backend-status-list__figure">{row.figure}</b> credits</>;
  }
  return <>{row.text === "Unlimited" ? "Unlimited credits" : "Credits available"}</>;
}

/**
 * The status column is a short label. Why a provider is unavailable can be a
 * sentence, so it goes on its own line under the name, where it can wrap.
 */
function unavailableLabel(backend: BackendSummary): string {
  return backend.kind === "claude" ? claudeProviderStatus(backend.claude).label : "Unavailable";
}

function UnavailableDetail({ backend }: { backend: BackendSummary }) {
  const detail = backend.unavailableReason?.trim();
  return detail ? <p className="backend-status-list__reason">{detail}</p> : null;
}

/**
 * An ACP agent that can only say "signed in to this provider" names its
 * account after the provider ("Grok account"), which the row above already
 * says. Auth carries the sign-in state for those agents.
 */
function showsAccount(backend: BackendSummary): boolean {
  if (!backend.account) return false;
  return !(
    backend.account.type === "provider"
    && formatBackendAccountText(backend.account) === `${backend.label} account`
  );
}

function hasProviderMetadata(backend: BackendSummary): boolean {
  return Boolean(
    backend.kind === "codex"
    || backendVersion(backend)
    || backend.runtimeBuild
    || backend.acp
    || backend.account?.planType
    || showsAccount(backend)
    || selectVisibleRateLimits(backend).length,
  );
}

function providerPlanText(backend: BackendSummary): string {
  if (backend.account?.planType) {
    return formatBackendPlanType(backend, backend.account.planType);
  }
  const account = backend.account;
  if (account?.type === "apiKey") return "API billing";
  if (account?.type === "chatgpt") return "Unavailable";
  if (account?.requiresOpenaiAuth === false) return "Not required";
  if (account?.requiresOpenaiAuth === true) return "Not signed in";
  return "Unavailable";
}

/**
 * Who supplied the runtime, in the operator's terms. The version alone cannot
 * answer it: `0.149.0` and `0.149.0-pwragent.2` differ by a suffix that reads
 * as noise until something names who published it.
 *
 * A channel this build has never heard of — a federated peer can be newer than
 * the viewer — falls back to the publisher alone. Naming it a release or a
 * build would describe an unknown channel in a known one's terms, which is the
 * confusion the row exists to remove.
 */
function formatRuntimeBuild(build: BackendRuntimeBuild): string {
  switch (build.channel) {
    case "pwragent":
      return `${build.publisher} build`;
    case "vendor":
      return `${build.publisher} release`;
    default: {
      // Exhaustiveness gate: adding a channel is a compile error here.
      const unhandled: never = build.channel;
      void unhandled;
      return build.publisher;
    }
  }
}

function backendVersion(backend: BackendSummary): string | undefined {
  return (
    backend.acp?.runtime?.agentInfo?.version
    ?? backend.acp?.version
    ?? backend.serverVersion
  );
}

function formatAcpAuthStatus(
  status: NonNullable<BackendSummary["acp"]>["authStatus"],
): string {
  switch (status) {
    case "authenticated":
      return "Signed in";
    case "required":
      return "Sign-in required";
    case "in-progress":
      return "Signing in";
    case "failed":
      return "Sign-in failed";
    case "not-required":
      return "Managed by provider";
  }
}
