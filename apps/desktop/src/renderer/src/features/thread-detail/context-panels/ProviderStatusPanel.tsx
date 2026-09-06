import { memo, useEffect } from "react";
import type { BackendRuntimeBuild, BackendSummary } from "@pwragent/shared";
import {
  formatBackendAccountText,
  formatRateLimitLine,
  selectVisibleRateLimits,
} from "../../../lib/backend-status-format";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";

type ProviderStatusPanelProps = {
  backends: BackendSummary[];
  backendError?: string;
};

/**
 * AI Provider Info tab — availability, runtime, authentication, account,
 * plan, and rate-limit lines for every configured agent backend.
 * Moved out of the old single-scroll context panel into its own tab.
 */
export const ProviderStatusPanel = memo(function ProviderStatusPanel(props: ProviderStatusPanelProps) {
  useEffect(() => {
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  }, []);

  return (
    <section className="context-panel__section">
      <h3>AI providers</h3>
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
                <span>{backend.label}</span>
              </div>
              <p className="backend-status-list__details">
                {backend.available
                  ? "Available"
                  : backend.unavailableReason ?? "Unavailable"}
              </p>
              {backend.available && hasProviderMetadata(backend) ? (
                <div className="backend-status-list__metadata">
                  {hasIdentityMetadata(backend) ? (
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
                      {backend.account ? (
                        <div>
                          <dt>Account</dt>
                          <dd>{formatBackendAccountText(backend.account)}</dd>
                        </div>
                      ) : null}
                      {backend.account?.planType ? (
                        <div>
                          <dt>Plan</dt>
                          <dd>{backend.account.planType}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                  {backend.rateLimits?.length ? (
                    <ul className="backend-status-list__limits">
                      {selectVisibleRateLimits(backend).map((limit) => (
                        <li key={`${limit.limitId ?? "limit"}:${limit.name}`}>
                          {formatRateLimitLine(limit)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
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

function hasProviderMetadata(backend: BackendSummary): boolean {
  return hasIdentityMetadata(backend) || Boolean(backend.rateLimits?.length);
}

/** Whether anything belongs in the identity grid above the rate limits. */
function hasIdentityMetadata(backend: BackendSummary): boolean {
  return Boolean(
    backendVersion(backend)
    || backend.runtimeBuild
    || backend.acp
    || backend.account,
  );
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
