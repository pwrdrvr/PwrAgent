import { useEffect, useState } from "react";
import type {
  DesktopHotCpuProfileStartDelayMs,
  DesktopHotCpuProfileTriggerMode,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { AppMetadata } from "../../../../shared/app-metadata";
import {
  buildCodexProtocolCaptureHandoffMessage,
  formatCodexProtocolCaptureSize,
  type CodexProtocolCaptureResult,
  type CodexProtocolCaptureStatus,
} from "../../../../shared/codex-protocol-capture";
import { HEAP_SNAPSHOT_SECRET_WARNING } from "../../../../shared/heap-snapshot";
import { buildTroubleshootingDiagnosticsInfo } from "../../../../shared/local-diagnostics-info";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { formatProcessIds, sourceBadge } from "./settings-fields";

const HOT_CPU_HEAP_SNAPSHOT_LIMIT_OPTIONS: Array<{
  label: string;
  meta: string;
  value: number;
}> = [
  { label: "2 snapshots", meta: "Start + stop", value: 2 },
  { label: "3 snapshots", meta: "Extra sample", value: 3 },
];

const HOT_CPU_START_DELAY_OPTIONS: Array<{
  label: string;
  meta: string;
  value: DesktopHotCpuProfileStartDelayMs;
}> = [
  { label: "Immediate", meta: "Arm now", value: 0 },
  { label: "5 seconds", meta: "Short setup", value: 5_000 },
  { label: "10 seconds", meta: "Long setup", value: 10_000 },
];

const HOT_CPU_TRIGGER_MODE_OPTIONS: Array<{
  label: string;
  meta: string;
  value: DesktopHotCpuProfileTriggerMode;
}> = [
  { label: "Spike", meta: "> 50%", value: "spike" },
  { label: "Sustained", meta: "2x > 50%", value: "sustained" },
  { label: "Slowburn", meta: "2x > 15%", value: "slowburn" },
];

/** Session-local, not persisted: it is a one-shot capture, not a preference. */
const HEAP_SNAPSHOT_DELAY_OPTIONS: Array<{
  label: string;
  meta: string;
  value: number;
}> = [
  { label: "Immediate", meta: "Capture now", value: 0 },
  { label: "5 seconds", meta: "Short setup", value: 5_000 },
  { label: "10 seconds", meta: "Long setup", value: 10_000 },
];

function formatHotCpuStartDelay(delayMs: DesktopHotCpuProfileStartDelayMs): string {
  return delayMs === 0 ? "Immediate" : `Delay ${Math.round(delayMs / 1_000)}s`;
}

export function TroubleshootingSettings(props: {
  desktopApi?: DesktopApi;
  onShowNotice?: (notice: AppNoticeToastNotice) => void;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onDeveloperModeChange: (value: boolean) => Promise<void>;
  onHotCpuProfilingEnabledChange: (value: boolean) => Promise<void>;
  onHotCpuProfilingStartDelayMsChange: (
    value: DesktopHotCpuProfileStartDelayMs,
  ) => Promise<void>;
  onHotCpuProfilingTriggerModeChange: (
    value: DesktopHotCpuProfileTriggerMode,
  ) => Promise<void>;
  onHotCpuProfilingCaptureHeapSnapshotChange: (value: boolean) => Promise<void>;
  onHotCpuProfilingHeapSnapshotLimitChange: (value: number) => Promise<void>;
}) {
  const [hotCpuCountdownEndsAt, setHotCpuCountdownEndsAt] = useState<
    number | null
  >(null);
  const [hotCpuCountdownRemainingMs, setHotCpuCountdownRemainingMs] =
    useState(0);
  const [heapSnapshotDelayMs, setHeapSnapshotDelayMs] = useState(0);
  const [heapSnapshotCountdownEndsAt, setHeapSnapshotCountdownEndsAt] =
    useState<number | null>(null);
  const [heapSnapshotCountdownRemainingMs, setHeapSnapshotCountdownRemainingMs] =
    useState(0);
  const [appMetadata, setAppMetadata] = useState<AppMetadata>();
  const [protocolCaptureStatus, setProtocolCaptureStatus] = useState<
    CodexProtocolCaptureStatus | undefined
  >();
  const [protocolCaptureBusy, setProtocolCaptureBusy] = useState(false);
  const [protocolCaptureError, setProtocolCaptureError] = useState<string>();
  const [lastProtocolCapture, setLastProtocolCapture] = useState<
    CodexProtocolCaptureResult | undefined
  >();
  const developerMode = props.snapshot.general.developerMode;
  const hotCpuProfilingEnabled =
    props.snapshot.general.hotCpuProfilingEnabled;
  const hotCpuProfilingStartDelayMs =
    props.snapshot.general.hotCpuProfilingStartDelayMs;
  const hotCpuProfilingTriggerMode =
    props.snapshot.general.hotCpuProfilingTriggerMode;
  const hotCpuProfilingSlowburnThresholdPercent =
    props.snapshot.general.hotCpuProfilingSlowburnThresholdPercent;
  const hotCpuProfilingCaptureHeapSnapshot =
    props.snapshot.general.hotCpuProfilingCaptureHeapSnapshot;
  const hotCpuProfilingHeapSnapshotLimit =
    props.snapshot.general.hotCpuProfilingHeapSnapshotLimit;
  const hotCpuCountdownActive = hotCpuCountdownRemainingMs > 0;
  const hotCpuCountdownSeconds = Math.ceil(hotCpuCountdownRemainingMs / 1_000);
  const hotCpuStartDelayText = formatHotCpuStartDelay(
    hotCpuProfilingStartDelayMs.value,
  );

  useEffect(() => {
    if (hotCpuCountdownEndsAt === null) {
      return;
    }

    const updateCountdown = () => {
      const remainingMs = Math.max(0, hotCpuCountdownEndsAt - Date.now());
      setHotCpuCountdownRemainingMs(remainingMs);
      if (remainingMs === 0) {
        setHotCpuCountdownEndsAt(null);
      }
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    return () => {
      window.clearInterval(interval);
    };
  }, [hotCpuCountdownEndsAt]);

  const startHotCpuCapture = async () => {
    await props.onHotCpuProfilingEnabledChange(true);
    if (hotCpuProfilingStartDelayMs.value > 0) {
      const endsAt = Date.now() + hotCpuProfilingStartDelayMs.value;
      setHotCpuCountdownEndsAt(endsAt);
      setHotCpuCountdownRemainingMs(hotCpuProfilingStartDelayMs.value);
    } else {
      setHotCpuCountdownEndsAt(null);
      setHotCpuCountdownRemainingMs(0);
    }
  };

  const stopHotCpuCapture = async () => {
    setHotCpuCountdownEndsAt(null);
    setHotCpuCountdownRemainingMs(0);
    await props.onHotCpuProfilingEnabledChange(false);
  };

  const heapSnapshotCountdownActive = heapSnapshotCountdownRemainingMs > 0;
  const heapSnapshotCountdownSeconds = Math.ceil(
    heapSnapshotCountdownRemainingMs / 1_000,
  );
  const heapSnapshotDelayText =
    HEAP_SNAPSHOT_DELAY_OPTIONS.find(
      (option) => option.value === heapSnapshotDelayMs,
    )?.label ?? "Immediate";

  // Mirrors the countdown the main process is already running, purely so the
  // row can say how long is left. If Settings closes, main still captures.
  useEffect(() => {
    if (heapSnapshotCountdownEndsAt === null) {
      return;
    }

    const updateCountdown = () => {
      const remainingMs = Math.max(0, heapSnapshotCountdownEndsAt - Date.now());
      setHeapSnapshotCountdownRemainingMs(remainingMs);
      if (remainingMs === 0) {
        setHeapSnapshotCountdownEndsAt(null);
      }
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    return () => {
      window.clearInterval(interval);
    };
  }, [heapSnapshotCountdownEndsAt]);

  const startHeapSnapshotCapture = async () => {
    const scheduled = await props.desktopApi?.captureHeapSnapshot?.({
      delayMs: heapSnapshotDelayMs,
      target: "both",
    });
    const delayMs = scheduled?.delayMs ?? heapSnapshotDelayMs;
    if (delayMs > 0) {
      setHeapSnapshotCountdownEndsAt(Date.now() + delayMs);
      setHeapSnapshotCountdownRemainingMs(delayMs);
    }
  };

  const protocolCaptureApiAvailable = Boolean(
    props.desktopApi?.getCodexProtocolCaptureStatus
    && props.desktopApi.startCodexProtocolCapture
    && props.desktopApi.stopCodexProtocolCapture,
  );
  const protocolCaptureStatusText = protocolCaptureBusy
    ? "Updating"
    : protocolCaptureStatus?.active
      ? "Recording"
      : !protocolCaptureApiAvailable
          || protocolCaptureStatus?.available === false
        ? "Unavailable"
        : protocolCaptureStatus === undefined
          ? "Checking"
          : "Idle";

  useEffect(() => {
    let canceled = false;
    if (!props.desktopApi?.getCodexProtocolCaptureStatus) {
      setProtocolCaptureStatus({ active: false, available: false });
      return;
    }

    void props.desktopApi.getCodexProtocolCaptureStatus()
      .then((status) => {
        if (!canceled) {
          setProtocolCaptureStatus(status);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setProtocolCaptureError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      canceled = true;
    };
  }, [props.desktopApi]);

  const startProtocolCapture = async () => {
    if (!props.desktopApi?.startCodexProtocolCapture) {
      return;
    }
    setProtocolCaptureBusy(true);
    setProtocolCaptureError(undefined);
    try {
      setProtocolCaptureStatus(
        await props.desktopApi.startCodexProtocolCapture(),
      );
      setLastProtocolCapture(undefined);
    } catch (error) {
      setProtocolCaptureError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setProtocolCaptureBusy(false);
    }
  };

  const stopProtocolCapture = async () => {
    if (!props.desktopApi?.stopCodexProtocolCapture) {
      return;
    }
    setProtocolCaptureBusy(true);
    setProtocolCaptureError(undefined);
    try {
      const result = await props.desktopApi.stopCodexProtocolCapture();
      setProtocolCaptureStatus({ active: false, available: true });
      if (!result) {
        return;
      }
      setLastProtocolCapture(result);
      const handoff = buildCodexProtocolCaptureHandoffMessage(result);
      const captureSize = result.sizeBytes === undefined
        ? "Size unavailable"
        : `Saved ${formatCodexProtocolCaptureSize(result.sizeBytes)}`;
      props.onShowNotice?.({
        actions: [
          {
            label: "Copy details",
            onClick: () => {
              void copyText(handoff, props.desktopApi);
            },
            tone: "primary",
          },
        ],
        copyText: handoff,
        detail: result.captureFilePath,
        id: `codex-protocol-capture:${result.stoppedAt}`,
        message: result.finalizationError
          ? `${captureSize}. Finalization reported a warning, so the capture may be partial. Copy the details for the diagnostic path and warning.`
          : `${captureSize}. Review the capture before sharing it; raw protocol traffic can contain conversation or workspace content.`,
        title: result.finalizationError
          ? "Codex protocol capture stopped with warning"
          : "Codex protocol capture saved",
        tone: result.finalizationError ? "warning" : "success",
      });
    } catch (error) {
      setProtocolCaptureError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setProtocolCaptureBusy(false);
    }
  };

  const processIds = appMetadata ? formatProcessIds(appMetadata) : undefined;

  useEffect(() => {
    let canceled = false;
    void props.desktopApi?.readAppMetadata?.().then((metadata) => {
      if (!canceled) {
        setAppMetadata(metadata);
      }
    });
    return () => {
      canceled = true;
    };
  }, [props.desktopApi]);

  return (
    <SettingsSectionStack
      paneId="troubleshooting"
      aria-label="Troubleshooting settings"
    >
      <SettingsPanelHead
        eyebrow="Troubleshooting"
        title="Troubleshooting"
        help="Inspect PwrAgent and capture diagnostics for performance issues."
      />

      <SettingsSection
        eyebrow="Troubleshooting"
        title="Chrome DevTools"
        chip={sourceBadge(developerMode)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={developerMode.value}
            disabled={props.saving}
            label="Developer Mode"
            sub="Expose Reload, Force Reload, and Developer Tools menu shortcuts."
            source={sourceBadge(developerMode)}
            onChange={(next) => {
              return props.onDeveloperModeChange(next);
            }}
          />
          <SettingsField
            label="Process IDs"
            sub="Attach a debugger or profiler to the right process when several Electron apps are running."
            control={
              appMetadata && processIds ? (
                <SettingsCopyValue
                  copyValue={buildTroubleshootingDiagnosticsInfo(appMetadata)}
                  desktopApi={props.desktopApi}
                  label="local diagnostics info"
                  value={processIds}
                />
              ) : (
                <span className="settings-hot-cpu-capture__status">
                  Unavailable
                </span>
              )
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Troubleshooting"
        title="Codex protocol capture"
      >
        <div className="settings-fields">
          <SettingsField
            label="Diagnostic snippet"
            sub="Start immediately before reproducing an issue, then stop as soon as it occurs. The capture stays local until you choose to share it."
            help="Raw protocol traffic can contain conversation content, file paths, and tool output. Review the file before sharing it."
            control={
              <div className="settings-hot-cpu-capture">
                {protocolCaptureStatus?.active ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={protocolCaptureBusy}
                    onClick={() => {
                      void stopProtocolCapture();
                    }}
                  >
                    Stop Protocol Capture
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={
                      protocolCaptureBusy
                      || !protocolCaptureApiAvailable
                      || protocolCaptureStatus?.available === false
                      || protocolCaptureStatus === undefined
                    }
                    onClick={() => {
                      void startProtocolCapture();
                    }}
                  >
                    Start Protocol Capture
                  </button>
                )}
                <span
                  className="settings-hot-cpu-capture__status"
                  aria-live="polite"
                >
                  {protocolCaptureStatusText}
                </span>
              </div>
            }
          />
          {lastProtocolCapture ? (
            <SettingsField
              label="Last capture"
              sub={[
                lastProtocolCapture.sizeBytes === undefined
                  ? "Size unavailable."
                  : `${formatCodexProtocolCaptureSize(lastProtocolCapture.sizeBytes)} saved.`,
                lastProtocolCapture.finalizationError
                  ? "Finalization reported a warning; the capture may be partial."
                  : "",
                "Copy the details to hand the diagnostic path to another agent.",
              ].filter(Boolean).join(" ")}
              control={
                <SettingsCopyValue
                  copyValue={buildCodexProtocolCaptureHandoffMessage(
                    lastProtocolCapture,
                  )}
                  desktopApi={props.desktopApi}
                  label="protocol capture details"
                  value={lastProtocolCapture.captureFilePath}
                />
              }
            />
          ) : null}
          {protocolCaptureError ? (
            <p className="settings-row__error" role="alert">
              {protocolCaptureError}
            </p>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Troubleshooting"
        title="CPU and heap monitoring"
        chip={sourceBadge(hotCpuProfilingEnabled)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Hot renderer CPU profiling"
            sub="Start an armed capture only after the presets below are ready."
            source={sourceBadge(hotCpuProfilingEnabled)}
            control={
              <div className="settings-hot-cpu-capture">
                {hotCpuProfilingEnabled.value || hotCpuCountdownActive ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={props.saving}
                    onClick={() => {
                      void stopHotCpuCapture();
                    }}
                  >
                    Stop Capture
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={props.saving}
                    onClick={() => {
                      void startHotCpuCapture();
                    }}
                  >
                    Start Capture ({hotCpuStartDelayText})
                  </button>
                )}
                <span
                  className="settings-hot-cpu-capture__status"
                  aria-live="polite"
                >
                  {hotCpuCountdownActive
                    ? `Starting in ${hotCpuCountdownSeconds}s`
                    : hotCpuProfilingEnabled.value
                      ? "Monitoring"
                      : "Not armed"}
                </span>
              </div>
            }
          />
          <SettingsField
            label="Profiling start delay"
            sub="Wait before the monitor starts sampling so you can trigger the scenario."
            source={sourceBadge(hotCpuProfilingStartDelayMs)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Profiling start delay"
              >
                {HOT_CPU_START_DELAY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={
                      hotCpuProfilingStartDelayMs.value === option.value
                    }
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      hotCpuProfilingStartDelayMs.value === option.value
                        ? " is-active"
                        : ""
                    }`}
                    disabled={props.saving}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onHotCpuProfilingStartDelayMsChange(
                        option.value,
                      );
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <SettingsField
            label="CPU profile trigger"
            sub="Choose whether one spike, two hot samples, or a lower slowburn starts the capture."
            help={`Slowburn currently uses ${hotCpuProfilingSlowburnThresholdPercent.value}% across the same consecutive-sample window.`}
            source={sourceBadge(hotCpuProfilingTriggerMode)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="CPU profile trigger"
              >
                {HOT_CPU_TRIGGER_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={
                      hotCpuProfilingTriggerMode.value === option.value
                    }
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      hotCpuProfilingTriggerMode.value === option.value
                        ? " is-active"
                        : ""
                    }`}
                    disabled={props.saving}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onHotCpuProfilingTriggerModeChange(
                        option.value,
                      );
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <ToggleField
            checked={hotCpuProfilingCaptureHeapSnapshot.value}
            disabled={props.saving}
            label="Smart heap snapshots"
            sub="Capture bounded heap snapshots around the next hot CPU trigger, then turn this option back off."
            help="Arms heap snapshots for the next explicit CPU capture start."
            source={sourceBadge(hotCpuProfilingCaptureHeapSnapshot)}
            onChange={(next) => {
              return props.onHotCpuProfilingCaptureHeapSnapshotChange(next);
            }}
          />
          <SettingsField
            label="Heap snapshot limit"
            sub="Keep emergency heap capture small enough to avoid filling disk or stalling the app repeatedly."
            source={sourceBadge(hotCpuProfilingHeapSnapshotLimit)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Heap snapshot limit"
              >
                {HOT_CPU_HEAP_SNAPSHOT_LIMIT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={
                      hotCpuProfilingHeapSnapshotLimit.value === option.value
                    }
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      hotCpuProfilingHeapSnapshotLimit.value === option.value
                        ? " is-active"
                        : ""
                    }`}
                    disabled={
                      props.saving || !hotCpuProfilingCaptureHeapSnapshot.value
                    }
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onHotCpuProfilingHeapSnapshotLimitChange(
                        option.value,
                      );
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <SettingsField
            label="Capture heap snapshot"
            sub="Snapshot both processes right now, without waiting for a CPU spike. Use the delay to stage the scenario first."
            control={
              <div className="settings-hot-cpu-capture">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!developerMode.value || heapSnapshotCountdownActive}
                  onClick={() => {
                    void startHeapSnapshotCapture();
                  }}
                >
                  Capture ({heapSnapshotDelayText})
                </button>
                <span
                  className="settings-hot-cpu-capture__status"
                  aria-live="polite"
                >
                  {!developerMode.value
                    ? "Requires Developer Mode"
                    : heapSnapshotCountdownActive
                      ? `Capturing in ${heapSnapshotCountdownSeconds}s`
                      : "Idle"}
                </span>
              </div>
            }
            help={`Capture runs in the main process, so you can close Settings while the countdown finishes. ${HEAP_SNAPSHOT_SECRET_WARNING}`}
          />
          <SettingsField
            label="Heap snapshot delay"
            sub="Wait before capturing so you can reproduce the state you want to inspect."
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Heap snapshot delay"
              >
                {HEAP_SNAPSHOT_DELAY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={heapSnapshotDelayMs === option.value}
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      heapSnapshotDelayMs === option.value ? " is-active" : ""
                    }`}
                    disabled={
                      !developerMode.value || heapSnapshotCountdownActive
                    }
                    role="radio"
                    type="button"
                    onClick={() => {
                      setHeapSnapshotDelayMs(option.value);
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}
