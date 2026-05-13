import { useEffect, useMemo, useState } from "react";
import type {
  DesktopCodexAuthProfileCandidate,
  DesktopCodexAuthProfileDiscoverySnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

const CREATE_VALUE = "__create_codex_profile__";

type CreationStep = "form" | "waiting" | "authenticated";

export function CodexAuthProfileSelect(props: {
  "aria-label": string;
  desktopApi?: DesktopApi;
  disabled?: boolean;
  discovery: DesktopCodexAuthProfileDiscoverySnapshot;
  value: string;
  onAfterProfilesChanged?: () => Promise<void>;
  onChange: (profile: string) => Promise<void> | void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedValue, setSelectedValue] = useState(props.value);
  const profiles = useMemo(
    () => ensureProfileOption(props.discovery.profiles, props.value),
    [props.discovery.profiles, props.value],
  );
  const selected =
    profiles.find((profile) => profile.name === props.value) ?? profiles[0];

  useEffect(() => {
    setSelectedValue(props.value);
  }, [props.value]);

  return (
    <div className="settings-codex-profile-select">
      <select
        aria-label={props["aria-label"]}
        className="settings-select"
        disabled={props.disabled}
        value={selectedValue}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === CREATE_VALUE) {
            setSelectedValue(props.value);
            setCreateOpen(true);
            return;
          }
          setSelectedValue(next);
          void props.onChange(next);
        }}
      >
        {profiles.map((profile) => (
          <option key={profile.name || "default"} value={profile.name}>
            {profile.displayName}
            {profile.hasAuthFile ? "" : " (no auth)"}
          </option>
        ))}
        <option value={CREATE_VALUE}>Create New Codex Profile...</option>
      </select>

      {selected ? <CodexAuthProfileDetails profile={selected} /> : null}

      {createOpen ? (
        <CodexAuthProfileCreateDialog
          desktopApi={props.desktopApi}
          existingProfiles={profiles}
          onCancel={() => setCreateOpen(false)}
          onCreated={async (profile) => {
            await props.onAfterProfilesChanged?.();
            await props.onChange(profile);
            setCreateOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function CodexAuthProfileDetails(props: {
  profile: DesktopCodexAuthProfileCandidate;
}) {
  const profile = props.profile;
  return (
    <div className="settings-codex-profile-details">
      <div className="settings-codex-profile-details__body">
        <span className="settings-pathrow__title">{profile.displayName}</span>
        <span className="settings-pathrow__path">{profile.codexHome}</span>
      </div>
      <div className="settings-pathrow__chips">
        <span className="settings-pathrow__chip">
          {profile.source === "default" ? "default" : "profile"}
        </span>
        <span
          className={`settings-pathrow__chip${
            profile.hasAuthFile || !profile.name
              ? ""
              : " settings-pathrow__chip--err"
          }`}
        >
          {profile.hasAuthFile ? "auth" : "no auth"}
        </span>
        {profile.hasConfigFile ? (
          <span className="settings-pathrow__chip">config</span>
        ) : null}
        {!profile.exists ? (
          <span className="settings-pathrow__chip settings-pathrow__chip--err">
            missing
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CodexAuthProfileCreateDialog(props: {
  desktopApi?: DesktopApi;
  existingProfiles: DesktopCodexAuthProfileCandidate[];
  onCancel: () => void;
  onCreated: (profile: string) => Promise<void>;
}) {
  const [profileName, setProfileName] = useState("");
  const [step, setStep] = useState<CreationStep>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [statusDetail, setStatusDetail] = useState<string>();
  const normalizedName = profileName.trim();
  const existingNames = new Set(props.existingProfiles.map((profile) => profile.name));
  const nameExists = Boolean(normalizedName) && existingNames.has(normalizedName);
  const validName = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedName);
  const canSubmit = Boolean(
    props.desktopApi?.createCodexAuthProfile
      && props.desktopApi.startCodexAuthProfileLogin
      && props.desktopApi.checkCodexAuthProfileStatus
      && normalizedName
      && validName
      && !nameExists,
  );

  const startLogin = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    setStatusDetail(undefined);
    try {
      await props.desktopApi!.createCodexAuthProfile!({ profile: normalizedName });
      await props.desktopApi!.startCodexAuthProfileLogin!({
        profile: normalizedName,
      });
      setStep("waiting");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const checkStatus = async () => {
    if (!props.desktopApi?.checkCodexAuthProfileStatus || !normalizedName) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const status = await props.desktopApi.checkCodexAuthProfileStatus({
        profile: normalizedName,
      });
      setStatusDetail(status.detail);
      if (status.authenticated) {
        setStep("authenticated");
        await props.onCreated(normalizedName);
      } else if (status.detail) {
        setError(status.detail);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        aria-labelledby="create-codex-profile-heading"
        aria-modal="true"
        className="settings-confirm-dialog settings-codex-profile-dialog"
        role="dialog"
      >
        <h2 id="create-codex-profile-heading">Create Codex profile</h2>
        {step === "form" ? (
          <>
            <p>Name the Codex auth profile to create under ~/.codex/profiles.</p>
            <input
              aria-label="Codex profile name"
              className="settings-input"
              placeholder="work"
              value={profileName}
              onChange={(event) => setProfileName(event.currentTarget.value)}
            />
            {!validName && normalizedName ? (
              <p className="settings-row__error">
                Use lowercase letters, numbers, dashes, or underscores.
              </p>
            ) : null}
            {nameExists ? (
              <p className="settings-row__error">That profile already exists.</p>
            ) : null}
          </>
        ) : (
          <>
            <p>
              Waiting for Codex login to finish for{" "}
              <strong>{normalizedName}</strong>. Complete the browser login, then
              check status here.
            </p>
            {statusDetail ? (
              <p className="settings-codex-profile-dialog__status">
                {statusDetail}
              </p>
            ) : null}
          </>
        )}
        {error ? (
          <p className="settings-row__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="settings-confirm-dialog__actions">
          <button
            className="button button--secondary"
            disabled={busy}
            type="button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          {step === "form" ? (
            <button
              className="button button--primary"
              disabled={busy || !canSubmit}
              type="button"
              onClick={() => {
                void startLogin();
              }}
            >
              Create and log in
            </button>
          ) : (
            <>
              <button
                className="button button--secondary"
                disabled={busy}
                type="button"
                onClick={() => {
                  void startLogin();
                }}
              >
                Restart login
              </button>
              <button
                className="button button--primary"
                disabled={busy}
                type="button"
                onClick={() => {
                  void checkStatus();
                }}
              >
                Check status
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ensureProfileOption(
  profiles: DesktopCodexAuthProfileCandidate[],
  value: string,
): DesktopCodexAuthProfileCandidate[] {
  if (!value || profiles.some((profile) => profile.name === value)) {
    return profiles;
  }
  return [
    ...profiles,
    {
      name: value,
      displayName: value,
      codexHome: value,
      exists: false,
      hasAuthFile: false,
      hasConfigFile: false,
      selected: false,
      source: "config",
    },
  ];
}
