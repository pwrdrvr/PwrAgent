import { useCallback, useEffect, useState } from "react";
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
 *   API and render its status. Does NOT auto-probe.
 * - On Test click: optimistically flip to `testing`, run the probe,
 *   show the result. Status pill stays on the latest result until
 *   the user clicks Test again.
 * - On `unset`: render a quiet "Not configured" pill — the user
 *   needs to enter credentials before the test makes sense.
 */
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
  desktopApi?: DesktopApi;
}) {
  const desktopApi = props.desktopApi;
  const [result, setResult] = useState<SettingsCredentialTestResult | undefined>(
    undefined,
  );
  const [testing, setTesting] = useState(false);

  // Pull the last result on mount so reopening the panel shows
  // "Connected · 2m ago" without re-probing. The main-process tester
  // caches the most recent result per kind in memory.
  useEffect(() => {
    let cancelled = false;
    const reader = desktopApi?.readLastSettingsCredentialTest;
    if (!reader) return;
    void reader({ kind: props.kind })
      .then((value) => {
        if (!cancelled) setResult(value);
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

  const status = testing
    ? "testing"
    : (result?.status ?? "idle");
  const name = result?.account ?? props.defaultName;
  const sub = describeSub({
    result,
    defaultSub: props.defaultSub,
    testing,
  });

  return (
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
        disabled={testing || !desktopApi?.testSettingsCredentials}
        type="button"
        onClick={() => {
          void onTest();
        }}
      >
        {testing ? "Testing…" : "Test"}
      </button>
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
