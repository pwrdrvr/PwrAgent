import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  DesktopGithubEnterpriseHostsPatch,
  DesktopGithubEnterpriseHostsSetting,
  GithubEnterpriseAccountPin,
  GithubEnterpriseDiscovery,
  GithubEnterpriseServer,
} from "@pwragent/shared/contracts/settings";
import {
  CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS,
  MIN_GH_ENTERPRISE_DISCOVERY_MINOR,
  mergeGithubEnterpriseHosts,
  normalizeGithubEnterpriseHost,
} from "@pwragent/shared/github-enterprise-hosts";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsField, SettingsSection } from "./SettingsLayout";

const MALFORMED = "config.toml has GitHub Enterprise hosts that are not a list of hostnames, so none are allowed.";
const NO_DISCOVERY: GithubEnterpriseDiscovery = { state: "unavailable", servers: [] };
type SavedChange = "saved" | "conflict" | "failed";

export function GithubEnterpriseHostsSettings(props: {
  hosts?: DesktopGithubEnterpriseHostsSetting;
  accounts?: readonly GithubEnterpriseAccountPin[];
  desktopApi?: DesktopApi;
  saving: boolean;
  onReload: () => Promise<void>;
  onSave: (patch: DesktopGithubEnterpriseHostsPatch) => Promise<SavedChange>;
  onAccountChange: (pin: GithubEnterpriseAccountPin) => Promise<boolean>;
}) {
  const discover = props.desktopApi?.discoverGithubEnterpriseAccounts;
  const recheckRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const discoveryInFlight = useRef(false);
  const writing = useRef(false);
  const [discovered, setDiscovery] = useState<GithubEnterpriseDiscovery>();
  const discovery = discover ? discovered : NO_DISCOVERY;
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [alert, setAlert] = useState<string>();
  const [nextFocus, setNextFocus] = useState<{ index: number; row?: Element }>();
  const saved = props.hosts?.value ?? [];
  const { servers, unused, slotsUsed } = mergeGithubEnterpriseHosts(saved, discovery?.servers ?? [], URL);
  const busy = props.saving || pending;
  const canWrite = !!props.hosts && !props.hosts.error;

  const recheck = useCallback(async () => {
    if (!discover || discoveryInFlight.current) return;
    discoveryInFlight.current = true;
    setChecking(true);
    try {
      setDiscovery(await discover());
    } catch {
      setDiscovery(NO_DISCOVERY);
    } finally {
      discoveryInFlight.current = false;
      setChecking(false);
    }
  }, [discover]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  useEffect(() => {
    if (!nextFocus || busy) return;
    const rows = listRef.current?.children;
    const row = nextFocus.row?.isConnected ? nextFocus.row : rows?.item(nextFocus.index);
    const control = row?.querySelector<HTMLElement>("input, button");
    (control ?? recheckRef.current)?.focus();
    setNextFocus(undefined);
  }, [busy, nextFocus]);

  const writeHosts = async (hosts: string[], host?: string, removed?: HTMLElement) => {
    if (!props.hosts || props.saving || writing.current) return;
    const index = removed ? Array.from(listRef.current?.children ?? []).indexOf(removed) : -1;
    const row = removed?.nextElementSibling ?? undefined;
    writing.current = true;
    setPending(true);
    setAlert(undefined);
    try {
      const result = await props.onSave({ hosts, expectedRevision: props.hosts.revision });
      if (result === "conflict") {
        await props.onReload();
        setAlert("The saved hosts changed in config.toml before this switch was saved, so it was not. The list now shows what is saved."
          + (host ? ` Turn ${host} on again if you still want it.` : ""));
      } else if (result === "saved" && removed) {
        setNextFocus({ index, row });
      } else if (result === "failed") {
        setAlert("The saved hosts could not be updated. Check Settings for the write error.");
      }
    } finally {
      writing.current = false;
      setPending(false);
    }
  };

  const writeAccount = async (host: string, login: string) => {
    if (props.saving || writing.current) return;
    writing.current = true;
    setPending(true);
    setAlert(undefined);
    try {
      if (!await props.onAccountChange({ host, login })) setAlert(`The GitHub account for ${host} could not be saved.`);
    } finally {
      writing.current = false;
      setPending(false);
    }
  };

  const signedIn = servers.filter((server) => !!server.activeLogin || server.accounts.length > 0).length;
  const notSignedIn = servers.length - signedIn;
  const status = discovery?.state === "ready" ? `${signedIn} ${signedIn === 1 ? "server" : "servers"} signed in, ${notSignedIn} not signed in.`
    : discovery?.state === "missing" ? "GitHub CLI is unavailable. See GitHub CLI (gh) above."
    : discovery?.state === "upgrade" ? `Update GitHub CLI to 2.${MIN_GH_ENTERPRISE_DISCOVERY_MINOR} or newer to check sign-ins. See GitHub CLI (gh) above.`
    : "GitHub CLI sign-ins could not be checked. See GitHub CLI (gh) above.";

  return (
    <SettingsSection
      eyebrow="GitHub"
      title="GitHub Enterprise hosts"
      description="Choose which servers Continue After can read CI runs from using your GitHub CLI sign-in."
    >
      <SettingsField
        label="Server sign-ins"
        sub={<span role="status">{checking || !discovery ? "Checking GitHub CLI sign-ins…" : status}</span>}
        control={
          <div className="settings-inline-actions">
            <button
              ref={recheckRef}
              className="button button--secondary"
              aria-disabled={checking || !discover || undefined}
              type="button"
              onClick={() => void recheck()}
            >
              Re-check
            </button>
          </div>
        }
      />
      {props.hosts?.error ? (
        <SettingsField
          label="Saved hosts"
          sub={<span className="settings-row__error" role="alert">{MALFORMED}</span>}
          control={
            <div className="settings-inline-actions">
              <button className="button button--secondary" disabled={busy} type="button" onClick={() => void writeHosts([])}>
                Clear saved hosts
              </button>
            </div>
          }
        />
      ) : null}
      {alert ? <div className="settings-button-row"><span className="settings-row__error" role="alert">{alert}</span></div> : null}
      <div ref={listRef} role="list" aria-label="GitHub Enterprise hosts" className="settings-fields settings-enterprise-host-list">
        {servers.map((server) => {
          const remaining = saved.filter((entry) => normalizeGithubEnterpriseHost(entry) !== server.host);
          return (
            <div role="listitem" key={server.host}>
              <EnterpriseServerRow
                server={server}
                pin={props.accounts?.find((entry) => entry.host === server.host)?.login}
                discoveryReady={discovery?.state === "ready"}
                locked={busy || !canWrite}
                atLimit={!server.allowed && slotsUsed >= CI_RUN_MAX_GITHUB_ENTERPRISE_HOSTS}
                desktopApi={props.desktopApi}
                onToggle={(allowed) => void writeHosts(allowed ? [...saved, server.host] : remaining, server.host)}
                onRemove={(row) => void writeHosts(remaining, server.host, row)}
                onAccountChange={(login) => void writeAccount(server.host, login)}
              />
            </div>
          );
        })}
        {unused.map(({ index, entry, reason }) => {
          const display = /[\r\n]/.test(entry) ? JSON.stringify(entry) : entry;
          return (
            <div role="listitem" key={`unused:${index}:${entry}`}>
              <SettingsField
                label={display}
                sub={<><span className="settings-pill settings-pill--neutral">Not used</span> {reason}</>}
                control={
                  <div className="settings-inline-actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      aria-label={`Remove ${display}`}
                      aria-disabled={busy || undefined}
                      onClick={(event) => {
                        const row = event.currentTarget.closest<HTMLElement>('[role="listitem"]');
                        if (!busy && row) void writeHosts(saved.filter((_, i) => i !== index), undefined, row);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                }
              />
            </div>
          );
        })}
      </div>
      <SettingsField
        label="Add a server"
        sub="Sign in to another server in Terminal, then click Re-check."
        control={<SettingsCopyValue desktopApi={props.desktopApi} label="Sign in to another server" value="gh auth login --hostname your-server" />}
      />
    </SettingsSection>
  );
}

function EnterpriseServerRow(props: {
  server: GithubEnterpriseServer & { allowed: boolean };
  pin?: string;
  discoveryReady: boolean;
  locked: boolean;
  atLimit: boolean;
  desktopApi?: DesktopApi;
  onToggle: (allowed: boolean) => void;
  onRemove: (row: HTMLElement) => void;
  onAccountChange: (login: string) => void;
}) {
  const helpId = useId();
  const { host, allowed, accounts, activeLogin, environmentToken } = props.server;
  const pinnedLogin = props.pin === undefined ? undefined
    : accounts.find((login) => login === props.pin);
  const missingPin = props.discoveryReady && props.pin !== undefined && !pinnedLogin;
  const login = props.pin === undefined ? activeLogin : pinnedLogin;
  const connected = !!login;
  const status = !props.discoveryReady ? "Unknown" : connected ? "Signed in" : "Not signed in";
  const tone = !props.discoveryReady ? "neutral" : connected ? "ok" : "warn";
  const activeOption = activeLogin ? `Active gh account (${activeLogin})` : "Active gh account";
  const locked = props.locked || props.atLimit;
  return (
    <SettingsField
      label={host}
      sub={
        <>
          <span className={`settings-pill settings-pill--${tone}`}>{status}</span>
          {missingPin ? <span> {props.pin || "The pinned account"} is not signed in.</span>
            : !props.discoveryReady && props.pin ? <span> Pinned account: {props.pin}.</span>
            : login && accounts.length < 2 ? <span> Reads use {login}.</span>
            : props.discoveryReady && !login && accounts.length > 0 ? <span> No active gh sign-in.</span> : null}
          {environmentToken && props.pin === undefined ? <span> Token from {environmentToken}</span> : null}
        </>
      }
      control={
        <div className="settings-inline-actions">
          <label className={`settings-switch settings-enterprise-host-switch${allowed ? " is-on" : ""}${locked ? " is-locked" : ""}`}>
            <input
              type="checkbox"
              role="switch"
              checked={allowed}
              aria-label={`Allow Continue After on ${host}`}
              aria-disabled={locked || undefined}
              aria-describedby={props.atLimit ? helpId : undefined}
              onChange={(event) => {
                if (!locked) props.onToggle(event.currentTarget.checked);
              }}
            />
            <span aria-hidden="true" className="settings-switch__track"><span className="settings-switch__thumb" /></span>
            <span aria-hidden="true">{allowed ? "Allowed" : "Off"}</span>
          </label>
          {props.atLimit ? <span className="settings-field__sub" id={helpId}>Turn another host off first</span> : null}
          {props.discoveryReady && accounts.length > 1 && !missingPin ? (
            <Select
              className="settings-select settings-select--chip"
              aria-label={`GitHub account for ${host}`}
              disabled={props.locked}
              value={pinnedLogin ?? ""}
              options={[{ value: "", label: activeOption }, ...accounts.map((account) => ({ value: account, label: account }))]}
              onChange={props.onAccountChange}
            />
          ) : null}
          {missingPin ? (
            <button type="button" className="button button--secondary" disabled={props.locked} onClick={() => props.onAccountChange("")}>
              {activeLogin ? `Use active account (${activeLogin})` : "Use active account"}
            </button>
          ) : null}
          {allowed && (!props.discoveryReady || !activeLogin && !accounts.length) ? (
            <button
              type="button"
              className="button button--secondary"
              aria-label={`Remove ${host}`}
              aria-disabled={props.locked || undefined}
              onClick={(event) => {
                const row = event.currentTarget.closest<HTMLElement>('[role="listitem"]');
                if (!props.locked && row) props.onRemove(row);
              }}
            >
              Remove
            </button>
          ) : null}
        </div>
      }
      actions={allowed && props.discoveryReady && !activeLogin && !accounts.length ? (
        <SettingsCopyValue desktopApi={props.desktopApi} label={`Sign in to ${host}`} value={`gh auth login --hostname ${host}`} compact />
      ) : undefined}
    />
  );
}
