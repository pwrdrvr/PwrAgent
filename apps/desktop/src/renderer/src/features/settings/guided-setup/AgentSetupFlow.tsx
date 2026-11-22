import { useState } from "react";
import type {
  AcpAgentSettingsEntry,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { ClaudeSignInControls } from "../../notifications/useClaudeSignIn";
import type { DesktopSettingsState } from "../useDesktopSettings";
import {
  AgentChooseStep,
  AgentReviewStep,
  AgentSignInStep,
  agentEnabled,
  agentInstalled,
  agentTabName,
  useAgentDiscovery,
  type AgentTabId,
} from "./AgentSetupSteps";
import {
  GuidedFooterBack,
  GuidedFooterHint,
  GuidedFooterSpacer,
  GuidedSetupFrame,
} from "./GuidedSetupFrame";

type AgentStep = "choose" | "sign-in" | "review";
const AGENT_STEPS: readonly AgentStep[] = ["choose", "sign-in", "review"];

/**
 * Guided agent setup: pick one agent and install it, sign in, review.
 * "Set up another agent" starts over on the pick step.
 */
export function AgentSetupFlow(props: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  claudeSignIn?: ClaudeSignInControls;
  initialAcpEntries?: readonly AcpAgentSettingsEntry[];
  initialBackends?: readonly BackendSummary[];
  entryAgent?: AgentTabId;
  onClose: () => void;
}) {
  const [step, setStep] = useState<AgentStep>("choose");
  const [active, setActive] = useState<AgentTabId>(props.entryAgent ?? "codex");
  const discovery = useAgentDiscovery({
    settings: props.settings,
    desktopApi: props.desktopApi,
    initialAcpEntries: props.initialAcpEntries,
    initialBackends: props.initialBackends,
  });
  const snapshot = props.settings.snapshot;
  const name = agentTabName(active);
  const ready =
    agentInstalled(active, snapshot, discovery.acpEntries, discovery.claude)
    && agentEnabled(active, snapshot);

  const index = AGENT_STEPS.indexOf(step);
  const steps = [
    { label: index > 0 ? name : "Pick and install" },
    { label: "Sign in" },
    { label: "Review" },
  ];

  let footer;
  if (step === "choose") {
    footer = (
      <>
        <GuidedFooterSpacer />
        <GuidedFooterHint>
          {ready
            ? `${name} is ready to sign in`
            : agentEnabled(active, snapshot)
              ? `Install ${name}, then refresh`
              : `Turn on ${name} to continue`}
        </GuidedFooterHint>
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          disabled={!ready}
          onClick={() => setStep("sign-in")}
        >
          Continue →
        </button>
      </>
    );
  } else if (step === "sign-in") {
    footer = (
      <>
        <GuidedFooterBack onBack={() => setStep("choose")} />
        <GuidedFooterSpacer />
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          onClick={() => setStep("review")}
        >
          Continue →
        </button>
      </>
    );
  } else {
    footer = (
      <>
        <GuidedFooterBack onBack={() => setStep("sign-in")} />
        <GuidedFooterSpacer />
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          onClick={props.onClose}
        >
          Done
        </button>
      </>
    );
  }

  return (
    <GuidedSetupFrame
      title="Set up an agent"
      crumb={step === "choose" ? "AI providers — Set up an agent" : `AI providers — ${name}`}
      steps={steps}
      currentIndex={index}
      onClose={props.onClose}
      footer={footer}
      stepKey={`${step}:${active}`}
    >
      {step === "choose" ? (
        <AgentChooseStep
          settings={props.settings}
          desktopApi={props.desktopApi}
          discovery={discovery}
          active={active}
          onActiveChange={setActive}
        />
      ) : null}
      {step === "sign-in" ? (
        <AgentSignInStep
          settings={props.settings}
          desktopApi={props.desktopApi}
          discovery={discovery}
          active={active}
          claudeSignIn={props.claudeSignIn}
        />
      ) : null}
      {step === "review" ? (
        <AgentReviewStep
          settings={props.settings}
          discovery={discovery}
          onSetUpAnother={() => setStep("choose")}
        />
      ) : null}
    </GuidedSetupFrame>
  );
}
