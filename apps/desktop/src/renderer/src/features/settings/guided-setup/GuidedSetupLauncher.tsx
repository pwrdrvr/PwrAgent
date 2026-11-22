import { createContext, useContext, type ReactNode } from "react";
import type { AgentTabId } from "./AgentSetupSteps";
import type { GuidedMessagingProvider } from "./messaging-setup-flow";

export type GuidedSetupRequest =
  | { flow: "agents"; agent?: AgentTabId }
  | { flow: "codex-profiles" }
  | { flow: "messaging"; provider?: GuidedMessagingProvider };

type Launch = (request: GuidedSetupRequest) => void;

const GuidedSetupLaunchContext = createContext<Launch | undefined>(undefined);

/** Lets Settings panes open a guided flow without threading a callback
 *  through every section. SettingsScreen owns the dialog. */
export function GuidedSetupLaunchProvider(props: {
  launch: Launch;
  children: ReactNode;
}) {
  return (
    <GuidedSetupLaunchContext.Provider value={props.launch}>
      {props.children}
    </GuidedSetupLaunchContext.Provider>
  );
}

export function useGuidedSetupLauncher(): Launch | undefined {
  return useContext(GuidedSetupLaunchContext);
}

/**
 * The entry-point button a Settings pane shows next to its dense form.
 * Renders nothing outside SettingsScreen, where there is no dialog to open.
 */
export function GuidedSetupButton(props: {
  request: GuidedSetupRequest;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  const launch = useGuidedSetupLauncher();
  if (!launch) return null;
  return (
    <button
      type="button"
      className={`button button--${props.variant ?? "secondary"}`}
      onClick={() => launch(props.request)}
    >
      {props.children}
    </button>
  );
}
