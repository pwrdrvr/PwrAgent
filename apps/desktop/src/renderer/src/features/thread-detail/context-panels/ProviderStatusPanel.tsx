import type { BackendSummary } from "@pwragent/shared";
import {
  formatBackendAccountText,
  formatRateLimitLine,
  selectVisibleRateLimits,
} from "../../../lib/backend-status-format";

type ProviderStatusPanelProps = {
  backends: BackendSummary[];
  backendError?: string;
};

/**
 * Provider Status tab — availability, account, plan, and rate-limit
 * lines for every configured app server (OpenAI, AgentCore-Grok, …).
 * Moved out of the old single-scroll context panel into its own tab.
 */
export function ProviderStatusPanel(props: ProviderStatusPanelProps) {
  return (
    <section className="context-panel__section">
      <h3>App servers</h3>
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
                  : (backend.unavailableReason ?? "Unavailable")}
              </p>
              {backend.available
              && (backend.account || (backend.rateLimits?.length ?? 0) > 0) ? (
                <div className="backend-status-list__metadata">
                  {backend.account ? (
                    <dl className="backend-status-list__metadata-grid">
                      <div>
                        <dt>Account</dt>
                        <dd>{formatBackendAccountText(backend.account)}</dd>
                      </div>
                      {backend.account.planType ? (
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
}
