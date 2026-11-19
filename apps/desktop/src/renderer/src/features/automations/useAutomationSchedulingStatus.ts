import { useEffect, useState } from "react";
import type { AutomationSchedulingStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * Whether this app instance runs scheduled automations. Read once when the
 * window loads, then kept current as another instance on the profile takes
 * them or hands them back.
 */
export function useAutomationSchedulingStatus(
  desktopApi: DesktopApi | undefined,
): AutomationSchedulingStatus | undefined {
  const [status, setStatus] = useState<AutomationSchedulingStatus>();
  useEffect(() => {
    let cancelled = false;
    let pushed = false;
    const unsubscribe = desktopApi?.onAutomationSchedulingStatus?.((next) => {
      pushed = true;
      setStatus(next);
    });
    void desktopApi?.readAutomationSchedulingStatus?.()
      .then((initial) => {
        // A pushed change is newer than this read.
        if (!cancelled && !pushed) setStatus(initial);
      })
      .catch(() => {
        // The button still opens automations; it just shows no state.
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);
  return status;
}

/** Tooltip lines and a short accessible suffix, or undefined when running here. */
export function describeAutomationSchedulingStatus(
  status: AutomationSchedulingStatus | undefined,
): { tooltip: string; ariaSuffix: string } | undefined {
  if (status?.state === "elsewhere") {
    const holder = [
      status.holder.cwdHint,
      status.holder.processId ? `pid ${status.holder.processId}` : undefined,
    ].filter(Boolean).join(" - ");
    return {
      ariaSuffix: "paused in this window",
      tooltip: [
        "Automations are paused in this window",
        `Another PwrAgent instance on this profile holds the background lease${holder ? ` (${holder})` : ""} and runs scheduled automations. This window takes over when that instance quits.`,
      ].join("\n"),
    };
  }
  if (status?.state === "disabled") {
    return {
      ariaSuffix: "off for this app instance",
      tooltip: [
        "Automations are off for this app instance",
        status.reason
          ? `It was launched with automations disabled: ${status.reason}`
          : "It was launched with automations disabled.",
      ].join("\n"),
    };
  }
  return undefined;
}
