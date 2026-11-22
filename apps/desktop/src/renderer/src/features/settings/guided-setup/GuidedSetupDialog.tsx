import type {
  AcpAgentSettingsEntry,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { PwrAgentProfilesState } from "../../../lib/usePwrAgentProfiles";
import type { ClaudeSignInControls } from "../../notifications/useClaudeSignIn";
import type { DesktopSettingsState } from "../useDesktopSettings";
import { AgentSetupFlow } from "./AgentSetupFlow";
import { CodexProfilesFlow } from "./CodexProfilesFlow";
import type { GuidedSetupRequest } from "./GuidedSetupLauncher";
import { MessagingSetupFlow } from "./MessagingSetupFlow";
import "./guided-setup.css";

/** The guided flow Settings has open, one at a time. */
export function GuidedSetupDialog(props: {
  request: GuidedSetupRequest;
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  profiles?: PwrAgentProfilesState;
  claudeSignIn?: ClaudeSignInControls;
  acpAgents?: readonly AcpAgentSettingsEntry[];
  cachedBackends?: readonly BackendSummary[];
  onClose: () => void;
}) {
  const { request } = props;
  if (request.flow === "agents") {
    return (
      <AgentSetupFlow
        settings={props.settings}
        desktopApi={props.desktopApi}
        claudeSignIn={props.claudeSignIn}
        initialAcpEntries={props.acpAgents}
        initialBackends={props.cachedBackends}
        entryAgent={request.agent}
        onClose={props.onClose}
      />
    );
  }
  if (request.flow === "codex-profiles") {
    return (
      <CodexProfilesFlow
        desktopApi={props.desktopApi}
        profiles={props.profiles}
        onClose={props.onClose}
      />
    );
  }
  return (
    <MessagingSetupFlow
      settings={props.settings}
      desktopApi={props.desktopApi}
      entryProvider={request.provider}
      onClose={props.onClose}
    />
  );
}
