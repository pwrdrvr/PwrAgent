import { memo, useEffect, useMemo } from "react";
import type { BackendRuntimeBuild, BackendSummary } from "@pwragent/shared";
import { PopoutIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  describeRateLimitRow,
  formatBackendAccountText,
  formatBackendPlanType,
  selectVisibleRateLimits,
  type BackendRateLimitSummary,
} from "../../../lib/backend-status-format";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import { limitSeriesFor, sinceResetSeries } from "../../federation-activity/usage-limits";
import { describeLimitPace } from "../../federation-activity/usage-activity-presentation";
import {
  useLocalUsagePace,
  usagePaceRefreshKey,
  type LocalUsagePace,
} from "../../federation-activity/useLocalUsagePace";

type ProviderStatusPanelProps = {
  backends: BackendSummary[];
  backendError?: string;
  desktopApi?: Pick<DesktopApi, "openUsageActivity" | "readUsageActivity">;
};

/**
 * AI Provider Info tab — availability, runtime, authentication, account,
 * plan, and rate-limit lines for every configured agent backend.
 *
 * Every provider's rows share one label column: the list is one grid and each
 * provider a subgrid of it, so a long label in one provider (Authentication)
 * does not leave another's values starting somewhere else. Credits and limits
 * are rows in that grid, not prose under it.
 */
export const ProviderStatusPanel = memo(function ProviderStatusPanel(props: ProviderStatusPanelProps) {
  useEffect(() => {
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  }, []);
  // Limit history is recorded on Codex turns only, so only Codex gets a pace.
  const hasCodexLimits = props.backends.some((backend) => backend.kind === "codex" && backend.rateLimits?.length);
  const pace = useLocalUsagePace(
    hasCodexLimits ? props.desktopApi?.readUsageActivity : undefined,
    usagePaceRefreshKey(props.backends),
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
                  {backend.available
                    ? "Available"
                    : backend.unavailableReason ?? "Unavailable"}
                </span>
              </div>
              {backend.available && hasProviderMetadata(backend) ? (
                <dl className="backend-status-list__metadata-grid">
                  {backendVersion(backend) ? (
                    <div>
                      <dt>Version</dt>
                      <dd>{backendVersion(backend)}</dd>
                    </div>
                  ) : null}
                  {backend.runtimeBuild ? (
                    <div>
                      <dt>Build</dt>
                      <dd>{formatRuntimeBuild(backend.runtimeBuild)}</dd>
                    </div>
                  ) : null}
                  {backend.acp ? (
                    <div>
                      <dt>Authentication</dt>
                      <dd>{formatAcpAuthStatus(backend.acp.authStatus)}</dd>
                    </div>
                  ) : null}
                  {backend.acp?.credentialScope === "owning-instance" ? (
                    <div>
                      <dt>Credentials</dt>
                      <dd>Owning instance only</dd>
                    </div>
                  ) : null}
                  {backend.acp?.supportLevel === "experimental" ? (
                    <div>
                      <dt>Support</dt>
                      <dd>Experimental</dd>
                    </div>
                  ) : null}
                  {backend.kind === "codex" || showsAccount(backend) ? (
                    <div>
                      <dt>Account</dt>
                      <dd>{backend.account ? formatBackendAccountText(backend.account) : "Unavailable"}</dd>
                    </div>
                  ) : null}
                  {backend.kind === "codex" || backend.account?.planType ? (
                    <div>
                      <dt>Plan</dt>
                      <dd>{providerPlanText(backend)}</dd>
                    </div>
                  ) : null}
                  {selectVisibleRateLimits(backend).map((limit) => (
                    <RateLimitRow
                      key={`${limit.limitId ?? "limit"}:${limit.name}`}
                      limit={limit}
                      now={now}
                      pace={backend.kind === "codex" ? pace : undefined}
                    />
                  ))}
                </dl>
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

function RateLimitRow({ limit, now, pace }: {
  limit: BackendRateLimitSummary;
  now: number;
  pace?: LocalUsagePace;
}) {
  const row = describeRateLimitRow(limit, now);
  const series = limitSeriesFor(pace?.account, limit);
  const described = series && pace && series.latest.usedPercent < 100
    ? describeLimitPace(series, pace.readAt, true)
    : undefined;
  // The meter always shows where the pace lands. The sentence is for the
  // window the Pricing card follows, and for any window about to run out.
  const sentence = described && (described.short || series === sinceResetSeries(pace?.account));
  const used = row.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, row.usedPercent));
  const projected = described
    ? described.projection.kind === "full" ? 100 : Math.min(100, described.projection.percent)
    : undefined;
  return (
    <div>
      <dt>{row.label}</dt>
      <dd>
        {row.figure ? <b className="backend-status-list__figure">{row.figure}</b> : null}
        {row.figure && row.text ? " " : null}
        {row.text}
        {row.reset ? <span className="backend-status-list__reset"> · {row.reset}</span> : null}
        {used !== undefined ? (
          <span className="backend-status-list__meter" aria-hidden="true">
            <i style={{ width: `${used}%` }} />
            {projected !== undefined && projected > used ? (
              <s
                className={described?.short ? "is-short" : undefined}
                style={{ left: `${used}%`, width: `${projected - used}%` }}
              />
            ) : null}
          </span>
        ) : null}
        {described && sentence ? (
          <span className={`usage-pace backend-status-list__pace${described.short ? " is-short" : ""}`}>
            <span>{described.rate}</span>
            {" "}
            {described.text}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * An ACP agent that can only say "signed in to this provider" names its
 * account after the provider ("Grok account"), which the row above already
 * says. Authentication carries the sign-in state for those agents.
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
