import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SettingsCredentialTestKind,
  SettingsCredentialTestResult,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * "Connection test" affordance for a single credential. Replaces the
 * v2 design's `pa-testblock` (see
 * `docs/design/pwragent-v2/project/settings.jsx:33-52`). One block per
 * credential — Telegram bot, Discord bot, Grok API key, Codex binary.
 *
 * Behavior contract:
 * - On mount: read the last-known result (if any) via the desktop
 *   API and render its status. Does NOT auto-probe: opening a page is
 *   not entering anything. Only a new `autoRun.key` runs the probe unasked.
 * - On Test click: optimistically flip to `testing`, run the probe,
 *   show the result. Status pill stays on the latest result until
 *   the user clicks Test again.
 * - On `unset`: render a quiet "Not configured" pill — the user
 *   needs to enter credentials before the test makes sense.
 */
/**
 * A single required/optional input the probe depends on. Rendered as a
 * checklist under the test row so the operator can see at a glance which
 * credentials are present before running the probe. Required prerequisites
 * that are unmet disable the Test button.
 */
export type SettingsTestPrerequisite = {
  label: string;
  met: boolean;
  /** Optional prerequisites are shown with a check but never block Test. */
  optional?: boolean;
};

export function SettingsTestBlock(props: {
  /** Discriminator for which probe runs in the main process. */
  kind: SettingsCredentialTestKind;
  /** Left-side icon (platform glyph or letter avatar). */
  icon: React.ReactNode;
  /** Default account / endpoint label shown until a real test runs.
   *  e.g. "@pwragent_bot" / "discord.com/api" / "api.x.ai/v1/models" */
  defaultName: string;
  /** Default sub-line shown until a real test runs.
   *  e.g. "Pings getMe on the Telegram Bot API." */
  defaultSub: string;
  /** Optional prerequisite checklist (present/valid-looking inputs). */
  prerequisites?: SettingsTestPrerequisite[];
  desktopApi?: DesktopApi;
  /** Latest result, remembered or fresh, for a guided setup's progress. */
  onResult?: (result: SettingsCredentialTestResult | undefined) => void;
  /**
   * Runs the test once, by itself, for each new `key`, as soon as `ready`
   * and the required prerequisites allow. A guided setup moves `key` on each
   * save and sets `ready` once every input it asks for is in: an operator
   * watched filling in Slack never knew to press Test. The key the block
   * mounts with never runs, and `ready` turning true alone never does either.
   * Saving is two renders, the snapshot and then the save resolving, and a
   * single key that read "entered" ran the test once for each.
   */
  autoRun?: { key: number; ready: boolean };
}) {
  const desktopApi = props.desktopApi;
  const [result, setResult] = useState<SettingsCredentialTestResult | undefined>(
    undefined,
  );
  const [testing, setTesting] = useState(false);
  const onResult = props.onResult;

  useEffect(() => {
    onResult?.(result);
  }, [onResult, result]);

  // Pull the last result on mount so reopening the panel shows
  // "Connected · 2m ago" without re-probing. The main-process tester
  // caches the most recent result per kind in memory.
  useEffect(() => {
    let cancelled = false;
    const reader = desktopApi?.readLastSettingsCredentialTest;
    if (!reader) return;
    void reader({ kind: props.kind })
      .then((value) => {
        // A test that finished first is newer than what main remembered.
        if (!cancelled) setResult((current) => current ?? value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktopApi, props.kind]);

  const onTest = useCallback(async () => {
    if (!desktopApi?.testSettingsCredentials) return;
    setTesting(true);
    try {
      const next = await desktopApi.testSettingsCredentials({ kind: props.kind });
      setResult(next);
    } catch (error) {
      setResult({
        kind: props.kind,
        status: "failed",
        testedAt: Date.now(),
        durationMs: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  }, [desktopApi, props.kind]);

  const prerequisites = props.prerequisites;
  const missingRequired = (prerequisites ?? []).filter(
    (item) => !item.optional && !item.met,
  );
  const blockedByPrereqs = missingRequired.length > 0;

  const autoRunKey = props.autoRun?.key;
  const autoRunReady = props.autoRun?.ready ?? false;
  const lastAutoRunKey = useRef(autoRunKey);
  useEffect(() => {
    if (autoRunKey === undefined || autoRunKey === lastAutoRunKey.current) return;
    // Held, not dropped: a save can resolve before the snapshot shows it,
    // and a test already running may have read the old inputs.
    if (!autoRunReady || blockedByPrereqs || testing) return;
    lastAutoRunKey.current = autoRunKey;
    void onTest();
  }, [autoRunKey, autoRunReady, blockedByPrereqs, onTest, testing]);

  const status = testing
    ? "testing"
    : (result?.status ?? "idle");
  const name = result?.account ?? props.defaultName;
  const sub = blockedByPrereqs
    ? `Enter ${missingRequired.map((item) => item.label).join(" and ")} to run the test.`
    : describeSub({
        result,
        defaultSub: props.defaultSub,
        testing,
      });

  return (
    <div className="settings-testblock-wrap">
      <div className="settings-testblock" data-status={status}>
        <span className="settings-testblock__icon" aria-hidden="true">
          {props.icon}
        </span>
        <div className="settings-testblock__main">
          <div className="settings-testblock__name">{name}</div>
          <div className="settings-testblock__sub">{sub}</div>
        </div>
        <span
          aria-live="polite"
          className={`settings-testblock__status settings-testblock__status--${status}`}
        >
          {describeStatus(status)}
        </span>
        <button
          className="button button--secondary"
          disabled={testing || blockedByPrereqs || !desktopApi?.testSettingsCredentials}
          type="button"
          onClick={() => {
            void onTest();
          }}
        >
          {testing ? "Testing…" : "Test"}
        </button>
      </div>
      {prerequisites && prerequisites.length > 0 ? (
        <ul className="settings-testblock__prereqs">
          {prerequisites.map((item) => (
            <li
              className={`settings-testblock__prereq${
                item.met ? " is-met" : " is-missing"
              }`}
              key={item.label}
            >
              <span className="settings-testblock__prereq-mark" aria-hidden="true">
                {item.met ? "✓" : "○"}
              </span>
              <span className="settings-testblock__prereq-label">
                {item.label}
                {item.optional ? " (optional)" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function describeStatus(
  status: "idle" | "testing" | "ok" | "failed" | "unset",
): string {
  switch (status) {
    case "ok":
      return "Connected";
    case "failed":
      return "Failed";
    case "testing":
      return "Testing…";
    case "unset":
      return "Not configured";
    default:
      return "Not tested";
  }
}

function describeSub(input: {
  result: SettingsCredentialTestResult | undefined;
  defaultSub: string;
  testing: boolean;
}): string {
  const { result, defaultSub, testing } = input;
  if (testing) return "Testing — see status";
  if (!result) return defaultSub;
  if (result.status === "unset") {
    return defaultSub;
  }
  if (result.status === "failed") {
    return result.errorMessage ?? defaultSub;
  }
  // ok
  const detail = result.detail ?? defaultSub;
  return `${detail} · ${formatRelative(result.testedAt)}`;
}

function formatRelative(timestamp: number): string {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}
