import { useEffect, useState } from "react";
import type {
  DesktopCodexDiscoveryCandidate,
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { formatSourceLabel, sourceBadge } from "./settings-fields";

type CodexPathMode = "auto" | "specified";

export function ModelsSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  onSaveCodexPath: (path: string) => Promise<void>;
}) {
  const [codexPath, setCodexPath] = useState(props.snapshot.models.codex.path.value);
  const [codexMode, setCodexMode] = useState<CodexPathMode>(
    props.snapshot.models.codex.path.value.trim() ? "specified" : "auto",
  );
  const [grokKey, setGrokKey] = useState("");
  const codex = props.snapshot.models.codex;
  const grok = props.snapshot.models.grok.apiKey;
  const envForced = codex.path.source === "env";
  const autoCandidates = codex.discovery.candidates.filter(
    (candidate) => candidate.source === "path" || candidate.source === "application",
  );
  const selectedLabel = codex.discovery.selectedCommand
    ? `Using ${codex.discovery.selectedCommand}`
    : "No executable Codex found";

  useEffect(() => {
    setCodexPath(codex.path.value);
    setCodexMode(codex.path.value.trim() || envForced ? "specified" : "auto");
  }, [codex.path.value, envForced]);

  const saveCodexPath = (path: string): void => {
    void props.onSaveCodexPath(path.trim());
  };

  return (
    <section className="settings-stack" aria-label="Model settings">
      <section className="settings-panel" aria-labelledby="settings-codex-title">
        <div className="settings-panel__header">
          <div>
            <p className="eyebrow">Models</p>
            <h2 id="settings-codex-title">Codex</h2>
          </div>
          <span className="settings-source">
            {codex.path.source === "default" ? "auto" : sourceBadge(codex.path)}
          </span>
        </div>
        <div className="settings-field">
          <div>
            <span className="settings-row__label">Codex selection</span>
            <span className="settings-source settings-source--wide">{selectedLabel}</span>
          </div>
          <div
            className="settings-segmented settings-segmented--two"
            role="radiogroup"
            aria-label="Codex selection mode"
          >
            <button
              aria-checked={codexMode === "auto" && !envForced}
              className={`settings-segmented__button${
                codexMode === "auto" && !envForced ? " is-active" : ""
              }`}
              disabled={props.saving || envForced}
              role="radio"
              type="button"
              onClick={() => {
                setCodexMode("auto");
                setCodexPath("");
                saveCodexPath("");
              }}
            >
              Auto Discovery - Use Newest
            </button>
            <button
              aria-checked={codexMode === "specified" || envForced}
              className={`settings-segmented__button${
                codexMode === "specified" || envForced ? " is-active" : ""
              }`}
              disabled={props.saving || envForced}
              role="radio"
              type="button"
              onClick={() => setCodexMode("specified")}
            >
              Specified Path
            </button>
          </div>
        </div>

        {codexMode === "specified" || envForced ? (
          <label className="settings-row">
            <span className="settings-row__label">Codex path</span>
            <input
              className="settings-input"
              disabled={props.saving || envForced}
              placeholder="Path to codex"
              value={codexPath}
              onBlur={() => saveCodexPath(codexPath)}
              onChange={(event) => setCodexPath(event.currentTarget.value)}
            />
          </label>
        ) : null}

        <div className="settings-discovery" aria-label="Codex discovery">
          {autoCandidates.length === 0 ? (
            <p className="settings-empty">No Codex candidates found.</p>
          ) : (
            autoCandidates.map((candidate) => (
              <CodexDiscoveryRow
                key={`${candidate.source}:${candidate.command}`}
                candidate={candidate}
                disabled={props.saving || envForced}
                onUse={(command) => {
                  setCodexMode("specified");
                  setCodexPath(command);
                  saveCodexPath(command);
                }}
              />
            ))
          )}
        </div>
      </section>

      <section className="settings-panel" aria-labelledby="settings-grok-title">
        <div className="settings-panel__header">
          <div>
            <p className="eyebrow">Models</p>
            <h2 id="settings-grok-title">Grok</h2>
          </div>
          <span className="settings-source">
            {grok.configured ? "Set" : "Not set"} ·{" "}
            {formatSourceLabel(grok.source, grok.overriddenByEnv)}
          </span>
        </div>
        <div className="settings-secret">
          <input
            aria-label="Grok API Key"
            className="settings-input"
            disabled={props.saving || !grok.writable}
            placeholder="••••••••"
            type="password"
            value={grokKey}
            onChange={(event) => setGrokKey(event.currentTarget.value)}
          />
          <button
            className="button button--secondary"
            disabled={props.saving || !grok.writable || !grokKey.trim()}
            type="button"
            onClick={() => {
              const nextValue = grokKey.trim();
              void props.onReplaceSecret("grokApiKey", nextValue).then((saved) => {
                if (saved) {
                  setGrokKey("");
                }
              });
            }}
          >
            Replace
          </button>
          <button
            className="button button--ghost"
            disabled={props.saving || !grok.writable || grok.source === "env"}
            type="button"
            onClick={() => {
              void props.onClearSecret("grokApiKey");
            }}
          >
            Clear
          </button>
        </div>
        {grok.unavailableReason ? (
          <p className="settings-row__error">{grok.unavailableReason}</p>
        ) : null}
      </section>
    </section>
  );
}

function CodexDiscoveryRow(props: {
  candidate: DesktopCodexDiscoveryCandidate;
  disabled?: boolean;
  onUse: (command: string) => void;
}) {
  const status = !props.candidate.executable
    ? "Not executable"
    : props.candidate.selected
      ? "Using"
      : "Available";
  const version =
    props.candidate.version
    ?? props.candidate.versionFailureReason
    ?? props.candidate.failureReason
    ?? "version unknown";

  return (
    <div
      className={`settings-discovery__row${
        props.candidate.selected ? " is-selected" : ""
      }`}
    >
      <span className="settings-discovery__command">{props.candidate.command}</span>
      <span className="settings-source">{props.candidate.source}</span>
      <span className="settings-source">{version}</span>
      <span className="settings-source">{status}</span>
      <button
        className="button button--secondary"
        disabled={props.disabled || !props.candidate.executable}
        type="button"
        onClick={() => props.onUse(props.candidate.command)}
      >
        Use
      </button>
    </div>
  );
}
