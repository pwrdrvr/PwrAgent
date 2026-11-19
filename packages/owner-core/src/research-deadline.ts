import { RESEARCH_MAX_TIMER_MS } from "@pwragent/shared/research";

/**
 * Arm `onDeadline` for `deadlineAt`. One timer cannot wait longer than `RESEARCH_MAX_TIMER_MS`, and a longer
 * delay fires at once, so a later deadline is waited in steps. `hold` receives the cancel for each step.
 */
export function armResearchDeadline(deadlineAt: number, now: () => number, schedule: (callback: () => void, delay: number) => () => void,
  onDeadline: () => void, hold: (cancel: () => void) => void): void {
  const arm = (): void => {
    const remaining = deadlineAt - now();
    hold(remaining > RESEARCH_MAX_TIMER_MS ? schedule(arm, RESEARCH_MAX_TIMER_MS) : schedule(onDeadline, Math.max(0, remaining)));
  };
  arm();
}
