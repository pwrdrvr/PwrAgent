import type { ThreadSpendAlert } from "@pwragent/shared";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildSpendAlertNotice(params: {
  alert: ThreadSpendAlert;
  threadLink?: ResolvedThreadLink;
}): AppNoticeToastNotice {
  const alert = params.alert;
  const spend = formatUsdMicros(alert.spendMicros);
  const threshold = formatUsdMicros(alert.thresholdMicros);
  const activeTurn = alert.kind === "active-turn-spend";
  return {
    autoDismiss: false,
    id: alert.alertId,
    message: activeTurn
      ? `This active turn has reached ${spend} in estimated list-price spend, crossing the configured ${threshold} threshold.`
      : `This thread has reached ${spend} in estimated list-price spend, crossing the configured ${threshold} threshold.`,
    ...(params.threadLink ? { threadLink: params.threadLink } : {}),
    title: activeTurn
      ? "Active turn spend threshold reached"
      : "Thread spend threshold reached",
    tone: "warning",
  };
}

function formatUsdMicros(micros: number): string {
  return (micros / 1_000_000).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
