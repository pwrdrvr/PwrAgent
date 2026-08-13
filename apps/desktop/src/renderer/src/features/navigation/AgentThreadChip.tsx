import { useViewportTooltip } from "../../lib/useViewportTooltip";

export const AGENT_THREAD_TOOLTIP =
  "Agent thread\nCan be assigned as a default target for a messaging platform or channel, helping people get started and providing this Agent's personality.";

export function AgentThreadChip(props: { threadRow?: boolean }) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <>
      <span
        aria-label="Agent thread"
        className={
          props.threadRow
            ? "thread-row__chip thread-row__chip--agent thread-row__chip--persistent"
            : "chip chip--agent"
        }
        onMouseEnter={(event) =>
          tooltip.show(event.currentTarget, AGENT_THREAD_TOOLTIP)
        }
        onMouseLeave={tooltip.hide}
      >
        Agent
      </span>
      {tooltip.tooltipNode}
    </>
  );
}
