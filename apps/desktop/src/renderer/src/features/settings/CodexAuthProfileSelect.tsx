import { useEffect, useMemo, useRef, useState } from "react";
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
          }}
        />
      ) : null}
    </div>
  );
}

export function CodexAuthProfileCreateButton(props: {
  desktopApi?: DesktopApi;
  disabled?: boolean;
  existingProfiles: DesktopCodexAuthProfileCandidate[];
  label?: string;
  onCreated: (profile: string) => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <button
        className="button button--secondary"
        disabled={props.disabled}
        type="button"
        onClick={() => setCreateOpen(true)}
      >
        {props.label ?? "Create Codex profile"}
      </button>
      {createOpen ? (
        <CodexAuthProfileCreateDialog
          desktopApi={props.desktopApi}
          existingProfiles={props.existingProfiles}
          onCancel={() => setCreateOpen(false)}
          onCreated={async (profile) => {
            await props.onCreated(profile);
          }}
        />
      ) : null}
    </>
  );
}

export function CodexAuthProfileLoginButton(props: {
  desktopApi?: DesktopApi;
  disabled?: boolean;
  displayName: string;
  profile: string;
  onAuthenticated?: () => Promise<void>;
}) {
  const [loginOpen, setLoginOpen] = useState(false);
  return (
    <>
      <button
        className="button button--secondary"
        disabled={props.disabled || !props.profile}
        type="button"
        onClick={() => setLoginOpen(true)}
      >
        Login
      </button>
      {loginOpen ? (
        <CodexAuthProfileLoginDialog
          desktopApi={props.desktopApi}
          displayName={props.displayName}
          profile={props.profile}
          onCancel={() => setLoginOpen(false)}
          onAuthenticated={props.onAuthenticated}
        />
      ) : null}
    </>
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
  const [loginUrl, setLoginUrl] = useState<string>();
  const [statusDetail, setStatusDetail] = useState<string>();
  const authenticatedRef = useRef(false);
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
    setLoginUrl(undefined);
    setStatusDetail(undefined);
    try {
      await props.desktopApi!.createCodexAuthProfile!({ profile: normalizedName });
      const login = await props.desktopApi!.startCodexAuthProfileLogin!({
        profile: normalizedName,
      });
      setLoginUrl(login.loginUrl);
      setStatusDetail(login.loginUrl ? undefined : login.detail);
      if (login.authenticated) {
        authenticatedRef.current = true;
        setStep("authenticated");
        setError(undefined);
        setStatusDetail(undefined);
        await props.onCreated(normalizedName);
        return;
      }
      setStep("waiting");
    } catch (nextError) {
      if (!authenticatedRef.current) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      setBusy(false);
    }
  };

  const openLoginLink = () => {
    if (loginUrl) {
      window.open(loginUrl, "_blank", "noopener,noreferrer");
    }
  };

  const checkStatus = async (options?: { auto?: boolean }) => {
    if (
      busy
      || !props.desktopApi?.checkCodexAuthProfileStatus
      || !normalizedName
    ) {
      return;
    }
    setBusy(true);
    if (!options?.auto) {
      setError(undefined);
    }
    try {
      const status = await props.desktopApi.checkCodexAuthProfileStatus({
        profile: normalizedName,
      });
      if (status.authenticated) {
        authenticatedRef.current = true;
        setStep("authenticated");
        setError(undefined);
        setStatusDetail(undefined);
        await props.onCreated(normalizedName);
      } else if (status.detail) {
        setStatusDetail(status.detail);
        if (!options?.auto) {
          setError(status.detail);
        }
      }
    } catch (nextError) {
      if (!options?.auto) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (step !== "waiting" || !props.desktopApi?.onWindowFocus) {
      return undefined;
    }
    return props.desktopApi.onWindowFocus(() => {
      void checkStatus({ auto: true });
    });
    // Rebind when the dialog advances between form/waiting/authenticated states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, props.desktopApi, normalizedName, busy]);

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
        ) : step === "authenticated" ? (
          <p>
            <strong>{normalizedName}</strong> is logged in.
          </p>
        ) : (
          <>
            <p>
              A browser window should open for{" "}
              <strong>{normalizedName}</strong>. Complete the Codex login, then
              check status here.
            </p>
            {loginUrl ? (
              <p className="settings-codex-profile-dialog__status">
                If it opened in the wrong browser profile,{" "}
                <button
                  className="settings-codex-profile-dialog__link"
                  type="button"
                  onClick={openLoginLink}
                >
                  open the login link again
                </button>
                .
              </p>
            ) : null}
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
          ) : step === "authenticated" ? (
            <button
              className="button button--primary"
              type="button"
              onClick={props.onCancel}
            >
              Done
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

function CodexAuthProfileLoginDialog(props: {
  desktopApi?: DesktopApi;
  displayName: string;
  profile: string;
  onCancel: () => void;
  onAuthenticated?: () => Promise<void>;
}) {
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [authenticated, setAuthenticated] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string>();
  const [statusDetail, setStatusDetail] = useState<string>();
  const authenticatedRef = useRef(false);
  const canLogin = Boolean(
    props.desktopApi?.startCodexAuthProfileLogin
      && props.desktopApi.checkCodexAuthProfileStatus
      && props.profile,
  );

  const startLogin = async () => {
    if (!canLogin) return;
    setBusy(true);
    setError(undefined);
    setLoginUrl(undefined);
    setStatusDetail(undefined);
    try {
      const login = await props.desktopApi!.startCodexAuthProfileLogin!({
        profile: props.profile,
      });
      setLoginUrl(login.loginUrl);
      setStatusDetail(login.loginUrl ? undefined : login.detail);
      if (login.authenticated) {
        authenticatedRef.current = true;
        setAuthenticated(true);
        setError(undefined);
        setStatusDetail(undefined);
      }
      setStarted(true);
    } catch (nextError) {
      if (!authenticatedRef.current) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void startLogin();
    // Start once when this modal opens. The Restart login button handles retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openLoginLink = () => {
    if (loginUrl) {
      window.open(loginUrl, "_blank", "noopener,noreferrer");
    }
  };

  const checkStatus = async (options?: { auto?: boolean }) => {
    if (
      busy
      || !props.desktopApi?.checkCodexAuthProfileStatus
      || !props.profile
    ) {
      return;
    }
    setBusy(true);
    if (!options?.auto) {
      setError(undefined);
    }
    try {
      const status = await props.desktopApi.checkCodexAuthProfileStatus({
        profile: props.profile,
      });
      if (status.authenticated) {
        authenticatedRef.current = true;
        setAuthenticated(true);
        setError(undefined);
        setStatusDetail(undefined);
      } else if (status.detail) {
        setStatusDetail(status.detail);
        if (!options?.auto) {
          setError(status.detail);
        }
      }
    } catch (nextError) {
      if (!options?.auto) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (authenticated || !started || !props.desktopApi?.onWindowFocus) {
      return undefined;
    }
    return props.desktopApi.onWindowFocus(() => {
      void checkStatus({ auto: true });
    });
    // Rebind as the login advances; the callback is intentionally one modal action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, started, props.desktopApi, props.profile, busy]);

  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        aria-labelledby="login-codex-profile-heading"
        aria-modal="true"
        className="settings-confirm-dialog settings-codex-profile-dialog"
        role="dialog"
      >
        <h2 id="login-codex-profile-heading">Log in to Codex profile</h2>
        {authenticated ? (
          <p>
            <strong>{props.displayName}</strong> is logged in.
          </p>
        ) : (
          <>
            <p>
              {started ? "A browser window should open" : "Starting Codex login"} for{" "}
              <strong>{props.displayName}</strong>. Complete the Codex login, then
              check status here.
            </p>
            {loginUrl ? (
              <p className="settings-codex-profile-dialog__status">
                If it opened in the wrong browser profile,{" "}
                <button
                  className="settings-codex-profile-dialog__link"
                  type="button"
                  onClick={openLoginLink}
                >
                  open the login link again
                </button>
                .
              </p>
            ) : null}
          </>
        )}
        {statusDetail ? (
          <p className="settings-codex-profile-dialog__status">
            {statusDetail}
          </p>
        ) : null}
        {error ? (
          <p className="settings-row__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="settings-confirm-dialog__actions">
          {authenticated ? (
            <button
              className="button button--primary"
              type="button"
              onClick={() => {
                void (async () => {
                  await props.onAuthenticated?.();
                  props.onCancel();
                })();
              }}
            >
              Done
            </button>
          ) : (
            <>
              <button
                className="button button--secondary"
                disabled={busy}
                type="button"
                onClick={props.onCancel}
              >
                Cancel
              </button>
              <button
                className="button button--secondary"
                disabled={busy || !canLogin}
                type="button"
                onClick={() => {
                  void startLogin();
                }}
              >
                Restart login
              </button>
              <button
                className="button button--primary"
                disabled={busy || !canLogin}
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
