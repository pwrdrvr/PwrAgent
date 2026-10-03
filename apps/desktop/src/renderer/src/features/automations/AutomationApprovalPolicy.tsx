import {
  resolveAutomationEscalationPolicy,
  resolveAutomationMcpQuestionPolicy,
  resolveAutomationMcpToolPolicy,
  type AutomationMcpApprovalPolicy,
  type AutomationMcpToolDecision,
  type DesktopMcpAutoApprovalSettings,
} from "@pwragent/shared";
import { useId, type ReactNode } from "react";
import { Select, type SelectOption } from "../../components/Select";

export type AutomationApprovalValue = Required<AutomationMcpApprovalPolicy>;

const TOOL_LABELS: Record<AutomationMcpToolDecision, string> = {
  auto: "Review each call",
  allow: "Pre-approve",
  backend: "Codex Auto decides",
  deny: "Block MCP tools",
};
const QUESTION_LABELS = { auto: "Review and answer", reject: "Cancel questions" } as const;
const ESCALATION_LABELS = { auto: "Review escalations", reject: "Stay in sandbox" } as const;
const NEEDS_REVIEWER = "Needs the reviewer. Turn it on in Settings → AI Providers.";

/**
 * The Run stage's Approvals group. Each Inherit option names what the run
 * will actually do, computed by the same resolvers the registry enforces, from
 * the run's effective access and the profile's approval reviewer.
 */
export function AutomationApprovalPolicy(props: {
  value: AutomationApprovalValue;
  onChange: (next: AutomationApprovalValue) => void;
  /** Undefined until the profile settings have been read. */
  reviewer?: Pick<DesktopMcpAutoApprovalSettings, "enabled" | "reviewEscalations" | "model" | "modelType">;
  /** The run's effective access: its own, else the Agent's. */
  executionMode?: string;
  /** The run's effective provider, and its label for copy. */
  backendKind?: string;
  backendLabel?: string;
}) {
  const id = useId();
  const { value, reviewer } = props;
  const reviewerOn = Boolean(reviewer?.enabled);
  const known = reviewer !== undefined;
  const tools = resolveAutomationMcpToolPolicy(value, props.executionMode, reviewerOn);
  const questions = resolveAutomationMcpQuestionPolicy(value, reviewerOn);
  const escalations = resolveAutomationEscalationPolicy(value, { enabled: reviewerOn, reviewEscalations: Boolean(reviewer?.reviewEscalations) });
  const inherit = (resolved: string) => (known ? `Inherit (${resolved})` : "Inherit");
  const set = (patch: Partial<AutomationApprovalValue>) => props.onChange({ ...value, ...patch });

  const codex = !props.backendKind || props.backendKind === "codex";
  const allInherit = value.tools === "inherit" && value.questions === "inherit" && value.escalations === "inherit";
  // Per-run approval is Codex thread configuration. On any other provider a
  // saved choice would stop the run at start, so the rows only show Inherit.
  const locked = !codex && allInherit;
  const mode = props.executionMode;

  const toolOptions: SelectOption<AutomationApprovalValue["tools"]>[] = [
    { value: "inherit", label: inherit(TOOL_LABELS[tools]), description: "Follows access and the reviewer setting." },
    { value: "auto", label: TOOL_LABELS.auto, description: reviewerOn || !known ? "The reviewer approves or declines each call." : NEEDS_REVIEWER, disabled: known && !reviewerOn && value.tools !== "auto" },
    { value: "allow", label: TOOL_LABELS.allow, description: "Every allowed tool runs without review." },
    { value: "backend", label: TOOL_LABELS.backend, description: mode === "auto" ? "PwrAgent gateway servers still use the reviewer." : "Needs Auto access.", disabled: mode !== "auto" && value.tools !== "backend" },
    { value: "deny", label: TOOL_LABELS.deny, description: "No MCP tool runs, even in Full Access." },
  ];
  const questionOptions: SelectOption<AutomationApprovalValue["questions"]>[] = [
    { value: "inherit", label: inherit(questions === "auto" ? QUESTION_LABELS.auto : "Cancel"), description: "Follows the reviewer setting." },
    { value: "auto", label: QUESTION_LABELS.auto, description: reviewerOn || !known ? "The reviewer answers from the task. An unknown answer is cancelled." : NEEDS_REVIEWER, disabled: known && !reviewerOn && value.questions !== "auto" },
    { value: "reject", label: QUESTION_LABELS.reject, description: "The server gets a cancel. Login flows are always cancelled." },
  ];
  const escalationOptions: SelectOption<AutomationApprovalValue["escalations"]>[] = [
    { value: "inherit", label: inherit(ESCALATION_LABELS[escalations]), description: reviewerOn && !reviewer?.reviewEscalations ? "Escalation review is off in Settings → AI Providers." : "Follows the reviewer setting." },
    { value: "auto", label: ESCALATION_LABELS.auto, description: reviewerOn || !known ? "Commands and file changes outside the sandbox go to the reviewer." : NEEDS_REVIEWER, disabled: known && !reviewerOn && value.escalations !== "auto" },
    { value: "reject", label: ESCALATION_LABELS.reject, description: "Nothing is asked. The sandbox blocks the operation." },
  ];

  const toolNote = known && !reviewerOn && value.tools === "auto"
    ? { warn: true, text: "With the reviewer off, every call is declined." }
    : tools === "backend" ? { warn: false, text: "PwrAgent gateway servers use the reviewer." } : undefined;
  const questionNote = known && !reviewerOn && value.questions === "auto"
    ? { warn: true, text: "With the reviewer off, every question is declined." } : undefined;
  const escalationNote = known && !reviewerOn && value.escalations === "auto"
    ? { warn: true, text: "With the reviewer off, the run stays in its sandbox." } : undefined;

  const row = (key: string, label: string, control: ReactNode, note?: { warn: boolean; text: string }) => (
    <div className="automation-approvals__row" key={key}>
      <span className="automation-approvals__label" id={`${id}-${key}`}>{label}</span>
      <div className="automation-approvals__control">
        {control}
        {note ? <span className={note.warn ? "automation-approvals__note automation-approvals__note--warn" : "automation-approvals__note"}>{note.text}</span> : null}
      </div>
    </div>
  );
  const fixed = (text: string) => <span className="automation-approvals__fixed">{text}</span>;

  return (
    <div className="automation-field automation-approvals" role="group" aria-labelledby={`${id}-title`}>
      <div className="automation-approvals__head">
        <span id={`${id}-title`}>Approvals</span>
        {known ? (
          <span className="automation-approvals__status">
            <span className={reviewerOn ? "automation-approvals__dot automation-approvals__dot--on" : "automation-approvals__dot"} aria-hidden="true" />
            {reviewerOn
              ? `Reviewer on · ${reviewer?.modelType !== "harness" ? reviewer?.model || "Direct API" : reviewer?.model || "Helper model"}`
              : "Reviewer off · Settings → AI Providers"}
          </span>
        ) : null}
      </div>
      {locked ? <>
        {row("tools", "Tool calls", fixed(inherit(TOOL_LABELS[tools])))}
        {row("questions", "MCP questions", fixed(inherit(questions === "auto" ? QUESTION_LABELS.auto : "Cancel")))}
        {mode === "default" || !mode ? row("escalations", "Escalations", fixed("Inherit")) : null}
      </> : <>
        {row("tools", "Tool calls", (
          <Select aria-label="Automation MCP tool approval" value={value.tools} options={toolOptions} onChange={(tools) => set({ tools })} />
        ), toolNote)}
        {row("questions", "MCP questions", (
          <Select aria-label="Automation MCP questions" value={value.questions} options={questionOptions} onChange={(questions) => set({ questions })} />
        ), questionNote)}
        {mode === "auto" || mode === "full-access"
          ? row("escalations", "Escalations", fixed(mode === "auto" ? "Handled by Codex Auto" : "Full Access asks nothing"))
          : row("escalations", "Escalations", (
            <Select aria-label="Automation Default Access escalations" value={value.escalations} options={escalationOptions} onChange={(escalations) => set({ escalations })} />
          ), escalationNote)}
      </>}
      <p className={!codex && !allInherit ? "automation-field__hint automation-approvals__note--warn" : "automation-field__hint"}>
        {codex
          ? "Only the servers and tools above can run. A timeout or a failed review never approves."
          : allInherit
            ? `${props.backendLabel ?? "This provider’s"} runs follow the reviewer. Choosing per automation needs a Codex Agent.`
            : "Per-automation approval needs a Codex Agent. Set these to Inherit, or the run will not start."}
      </p>
    </div>
  );
}
