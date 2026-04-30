import { useState } from "react";
import type {
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
} from "@pwragnt/shared";
import { formatSourceLabel, sourceBadge } from "./settings-fields";

export function ModelsSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<void>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<void>;
  onSaveCodexPath: (path: string) => Promise<void>;
}) {
  const [codexPath, setCodexPath] = useState(props.snapshot.models.codex.path.value);
  const [grokKey, setGrokKey] = useState("");
  const codex = props.snapshot.models.codex;
  const grok = props.snapshot.models.grok.apiKey;

  return (
    <section className="settings-stack" aria-label="Model settings">
      <section className="settings-panel" aria-labelledby="settings-codex-title">
        <div className="settings-panel__header">
          <div>
            <p className="eyebrow">Models</p>
            <h2 id="settings-codex-title">Codex</h2>
          </div>
          <span className="settings-source">{sourceBadge(codex.path)}</span>
        </div>
        <label className="settings-row">
          <span className="settings-row__label">Codex path</span>
          <input
            className="settings-input"
            disabled={props.saving}
            placeholder="Auto discovery"
            value={codexPath}
            onBlur={() => {
              void props.onSaveCodexPath(codexPath.trim());
            }}
            onChange={(event) => setCodexPath(event.currentTarget.value)}
          />
        </label>

        <div className="settings-discovery" aria-label="Codex discovery">
          {codex.discovery.candidates.length === 0 ? (
            <p className="settings-empty">No Codex candidates found.</p>
          ) : (
            codex.discovery.candidates.map((candidate) => (
              <div
                key={`${candidate.source}:${candidate.command}`}
                className={`settings-discovery__row${
                  candidate.selected ? " is-selected" : ""
                }`}
              >
                <span className="settings-discovery__command">{candidate.command}</span>
                <span className="settings-source">{candidate.source}</span>
                <span className="settings-source">
                  {candidate.version ?? candidate.failureReason ?? "version unknown"}
                </span>
              </div>
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
              setGrokKey("");
              void props.onReplaceSecret("grokApiKey", nextValue);
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
