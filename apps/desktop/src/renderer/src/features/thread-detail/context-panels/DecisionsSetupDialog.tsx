import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DECISION_JEV_ENDPOINT,
  DECISION_PROVIDER_LINKS,
  resolveDecisionModelSettings,
  type DecisionProviderReadiness,
  type DecisionRunProvider,
} from "@pwragent/shared/decision-models";
import { CloseIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useModalDialog } from "../../../lib/useModalDialog";
import { SecretField } from "../../settings/SecretField";
import { SettingsTestBlock } from "../../settings/SettingsTestBlock";
import type { DecisionSetupSettings } from "./decision-setup";
import {
  DECISION_SETUP_FOCUS,
  decisionReadinessLabel,
  decisionSetupReadiness,
  decisionSetupSecrets,
} from "./decision-setup";
import { decisionProviderSettingsName } from "./decisions-format";

const OPENAI_API_KEYS_URL = "https://platform.openai.com/api-keys";

/**
 * Set up decisions: the three providers on one screen, each with the one
 * thing it needs (a key, or choosing the local model), in the order agents
 * prefer them. Keys save through the same secret store as Settings → AI
 * Providers, so this dialog and Settings never disagree.
 */
export function DecisionsSetupDialog(props: {
  settings: DecisionSetupSettings;
  desktopApi?: DesktopApi;
  onOpenSettings?: (focus?: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentRef = useModalDialog({ onClose: props.onClose, initialFocus: closeRef });
  const snapshot = props.settings.snapshot;
  const readiness = decisionSetupReadiness(snapshot);
  const [openCard, setOpenCard] = useState<DecisionRunProvider | undefined>(
    () => readiness?.providers.find((entry) => entry.enabled && !entry.ready)?.provider,
  );
  const [chooseError, setChooseError] = useState<string>();
  const saving = props.settings.saving;

  const openSettings = (focus?: string): void => {
    props.onClose();
    props.onOpenSettings?.(focus);
  };

  const chooseLocal = async (): Promise<void> => {
    if (!snapshot) return;
    setChooseError(undefined);
    const current = snapshot.models.decisionModels ?? {};
    const saved = await props.settings.writeConfig({ models: { decisionModels: { ...current, model: "local" } } });
    if (!saved) setChooseError("Couldn't choose the local model. Try again from Settings.");
  };

  if (typeof document === "undefined") return null;

  const body = !snapshot || !readiness ? (
    <p className="decisions-setup__loading">Reading Settings…</p>
  ) : (
    <ul className="decisions-setup__cards">
      {readiness.providers.map((entry) => {
        const secrets = decisionSetupSecrets(snapshot);
        const resolved = resolveDecisionModelSettings(snapshot.models.decisionModels);
        const expanded = openCard === entry.provider;
        const card = PROVIDER_CARDS[entry.provider];
        const facts = entry.provider === "openai"
          ? ["gpt-6-luna", "bills your OpenAI API project"]
          : entry.provider === "jev"
            ? [resolved.jevModel, "hosted by TypeSafe"]
            : [resolved.localModel, resolved.localEndpoint.replace(/^https?:\/\//, ""), "stays on this Mac"];
        return (
          <li key={entry.provider} className={`decisions-setup__card${expanded ? " decisions-setup__card--open" : ""}`}>
            <div className="decisions-setup__card-head">
              <span className="decisions-setup__mark" aria-hidden="true">{card.mark}</span>
              <div className="decisions-setup__card-name">
                <h3>{decisionProviderSettingsName(entry.provider)}</h3>
                <p>{card.summary}</p>
              </div>
              <div className="decisions-setup__card-action">
                <ReadinessPill entry={entry} />
                {!entry.enabled ? (
                  <button type="button" className="button button--ghost" onClick={() => openSettings(DECISION_SETUP_FOCUS[entry.provider])}>
                    Turn on
                  </button>
                ) : entry.provider === "local" && !entry.ready ? (
                  <button type="button" className="button button--ghost" disabled={saving} onClick={() => void chooseLocal()}>
                    Use local model
                  </button>
                ) : entry.provider !== "local" ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    aria-expanded={expanded}
                    onClick={() => setOpenCard(expanded ? undefined : entry.provider)}
                  >
                    {expanded ? "Hide" : entry.ready ? "Change key" : "Add key"}
                  </button>
                ) : null}
              </div>
            </div>
            <p className="decisions-setup__facts">
              {facts.map((fact) => <span key={fact}>{fact}</span>)}
            </p>
            {entry.provider === "local" && chooseError ? (
              <p className="rail-card__error" role="alert">{chooseError}</p>
            ) : null}
            {entry.provider === "local" && entry.ready ? (
              <div className="decisions-setup__fields settings-fields">
                <SettingsTestBlock
                  kind="decision-local"
                  desktopApi={props.desktopApi}
                  icon={<span aria-hidden="true">C</span>}
                  defaultName={resolved.localEndpoint}
                  defaultSub="Checks the server offers the model. Runs no decision."
                />
              </div>
            ) : null}
            {expanded && entry.provider === "openai" ? (
              <div className="decisions-setup__fields settings-fields">
                <SecretField
                  label="OpenAI API key"
                  sub={<>An API key from a project that can call the Decisions API. Signing in to Codex does not provide one. <ExternalLink href={OPENAI_API_KEYS_URL}>Create a key</ExternalLink></>}
                  secret="openaiDecisionsApiKey"
                  state={snapshot.models.openaiDecisions?.apiKey ?? secrets.unset}
                  disabled={saving}
                  onClearSecret={props.settings.clearSecret}
                  onReplaceSecret={props.settings.replaceSecret}
                />
              </div>
            ) : null}
            {expanded && entry.provider === "jev" ? (
              <div className="decisions-setup__fields settings-fields">
                <SecretField
                  label="TypeSafe API key"
                  sub={<>From the TypeSafe console. <ExternalLink href={DECISION_PROVIDER_LINKS.jevConsole}>Get a key</ExternalLink></>}
                  secret="typesafeJevApiKey"
                  state={secrets.jevApiKey}
                  disabled={saving}
                  onClearSecret={props.settings.clearSecret}
                  onReplaceSecret={props.settings.replaceSecret}
                />
                {secrets.jevApiKey.configured ? (
                  <SettingsTestBlock
                    kind="decision-jev"
                    desktopApi={props.desktopApi}
                    icon={<span aria-hidden="true">J</span>}
                    defaultName={DECISION_JEV_ENDPOINT.replace(/^https:\/\//, "")}
                    defaultSub="Asks one yes/no question with the saved key."
                  />
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return createPortal(
    <div className="subagent-modal" role="dialog" aria-modal="true" aria-labelledby="decisions-setup-title" onClick={props.onClose}>
      <div
        ref={contentRef}
        className="subagent-modal__content decisions-setup"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="subagent-modal__head">
          <div className="subagent-modal__identity">
            <p className="decisions-setup__eyebrow">Decisions</p>
            <h2 className="subagent-modal__title" id="decisions-setup-title">Choose where decisions run</h2>
            <p className="decisions-setup__lede">
              One provider is enough. Agents use the first one that is ready, in this order.
            </p>
          </div>
          <div className="subagent-modal__actions">
            <button
              type="button"
              ref={closeRef}
              className="subagent-modal__close"
              aria-label="Close"
              onClick={props.onClose}
            >
              <CloseIcon size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="subagent-modal__body">{body}</div>
        <div className="decisions-setup__foot">
          {props.onOpenSettings ? (
            <button type="button" className="button button--ghost" onClick={() => openSettings(undefined)}>
              All decision settings
            </button>
          ) : <span />}
          <button type="button" className="button button--primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const PROVIDER_CARDS: Record<DecisionRunProvider, { mark: string; summary: string }> = {
  openai: { mark: "O", summary: "OpenAI's Decisions API, on your own API key." },
  jev: { mark: "J", summary: "TypeSafe's hosted decision model." },
  local: { mark: "C", summary: "A decision model on this Mac, such as Cloudflare's Clef." },
};

function ReadinessPill(props: { entry: DecisionProviderReadiness }) {
  const tone = props.entry.ready ? "ok" : props.entry.enabled ? "warning" : "muted";
  return <span className={`decisions-setup__pill decisions-setup__pill--${tone}`}>{decisionReadinessLabel(props.entry)}</span>;
}

/** Opens in the browser; main's window guard allows only safe external URLs. */
function ExternalLink(props: { href: string; children: ReactNode }) {
  return <a href={props.href} target="_blank" rel="noreferrer">{props.children}</a>;
}
